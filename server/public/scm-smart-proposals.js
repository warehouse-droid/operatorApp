const SMART_PROPOSAL_COLUMN_PREFERENCES_KEY = "mbbs.smartScm.proposalColumns.v1";

function smartLoadProposalColumnPreferences() {
  const defaults = { compact: true, inventory: true, decisionEvidence: true };
  try {
    const saved = globalThis.localStorage?.getItem(SMART_PROPOSAL_COLUMN_PREFERENCES_KEY);
    if (!saved) return defaults;
    const parsed = JSON.parse(saved);
    return {
      compact: typeof parsed?.compact === "boolean" ? parsed.compact : defaults.compact,
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
      compact: smartState.planCompact,
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
if (typeof smartState.planCompact !== "boolean") smartState.planCompact = smartInitialProposalColumns.compact;
if (typeof smartState.planShowInventory !== "boolean") smartState.planShowInventory = smartInitialProposalColumns.inventory;
if (typeof smartState.planShowDecisionEvidence !== "boolean") smartState.planShowDecisionEvidence = smartInitialProposalColumns.decisionEvidence;
if (typeof smartState.planVendor !== "string") smartState.planVendor = "";

const SMART_URGENCY_LEVELS = ["normal", "urgent", "super_urgent", "ultimate_urgent"];
const SMART_PROPOSAL_YARD_SEQUENCE = ["3445", "12441", "2967", "150"];
const SMART_PROPOSAL_YARD_RANK = new Map(SMART_PROPOSAL_YARD_SEQUENCE.map((yard, index) => [yard, index]));

function smartUrgencyLevel(value, urgent = false) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (normalized === "normal" && urgent) return "urgent";
  return SMART_URGENCY_LEVELS.includes(normalized) ? normalized : urgent ? "urgent" : "normal";
}

function smartUrgencyRank(level) {
  return SMART_URGENCY_LEVELS.indexOf(smartUrgencyLevel(level));
}

function smartUrgencyLabel(level) {
  return smartUrgencyLevel(level).split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function smartLineUrgencyLevel(line = {}) {
  return smartUrgencyLevel(line.urgencyLevel ?? line.reason?.urgencyLevel, Boolean(line.urgent || line.reason?.urgent));
}

function smartProposalUrgencyLevel(proposal = {}) {
  const explicit = smartUrgencyLevel(proposal.urgencyLevel, Boolean(proposal.urgent));
  return (proposal.lines || []).reduce((highest, line) => {
    const level = smartLineUrgencyLevel(line);
    return smartUrgencyRank(level) > smartUrgencyRank(highest) ? level : highest;
  }, explicit);
}

function smartProposalUrgencyScore(proposal = {}) {
  if (proposal.urgencyScore !== null && proposal.urgencyScore !== undefined && proposal.urgencyScore !== ""
    && Number.isFinite(Number(proposal.urgencyScore))) return Number(proposal.urgencyScore);
  const highestLevel = smartProposalUrgencyLevel(proposal);
  const candidates = (proposal.lines || [])
    .filter((line) => smartLineUrgencyLevel(line) === highestLevel)
    .flatMap((line) => [line.urgencyScore, line.reason?.urgencyScore])
    .map(Number)
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function smartNormalizedVendor(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function smartProposalVendor(proposal = {}) {
  return String(proposal.vendor || proposal.sourceName || "").trim().replace(/\s+/g, " ");
}

function smartReasonNumber(reason, key) {
  const value = reason?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function smartOptionalNumber(value, places = 1) {
  return value === null || value === undefined ? "—" : smartNumber(value, places);
}

function smartProposalDestinationAllocations(line = {}) {
  const saved = Array.isArray(line.reason?.destinationAllocations)
    ? line.reason.destinationAllocations
    : [];
  const physicalYard = smartProposalYardCode(line.destinationName) || String(line.destinationName || "").trim();
  return saved
    .map((allocation) => {
      const yard = String(allocation?.yard || "").trim();
      const proposedPallets = Number(allocation?.proposedPallets);
      const fulfillment = ["vendor_direct", "transfer_later"].includes(allocation?.fulfillment)
        ? allocation.fulfillment
        : yard === physicalYard ? "vendor_direct" : "transfer_later";
      return { yard, proposedPallets, fulfillment };
    })
    .filter((allocation) => allocation.yard
      && Number.isFinite(allocation.proposedPallets)
      && allocation.proposedPallets > 0);
}

function smartProposalAllocationSummary(line = {}) {
  const allocations = smartProposalDestinationAllocations(line);
  if (!allocations.length) return "";
  return `<div class="smart-destination-allocations">${allocations.map((allocation) => {
    const label = allocation.fulfillment === "transfer_later" ? "Transfer later" : "Vendor direct";
    return `<span><strong>${smartEscape(allocation.yard)}</strong> · ${label} · ${smartNumber(allocation.proposedPallets, 2)} PLT</span>`;
  }).join("")}</div>`;
}

function smartProposalIsHubLine(proposal = {}, line = {}) {
  const phase = String(proposal.phase || "").trim().toLowerCase();
  if (["vendor_hub", "hub_store"].includes(phase)) return true;
  if (proposal.proposalType !== "PO") return false;
  const reason = line.reason || {};
  if (reason.gormleyHubRedirected === true || reason.routeRulePartialRedirected === true) return true;
  if (smartProposalDestinationAllocations(line).some((allocation) => allocation.fulfillment === "transfer_later")) {
    return true;
  }
  const physicalYard = smartProposalYardCode(line.destinationName || proposal.destinationName);
  const demandYard = smartProposalYardCode(reason.actualDestinationYard);
  return Boolean(physicalYard && demandYard && physicalYard !== demandYard);
}

function smartProposalHubAvailabilityTag(proposal, line) {
  return smartProposalIsHubLine(proposal, line)
    ? '<span class="smart-availability-hub-tag" title="This line uses the vendor hub for receipt or onward transfer.">HUB</span>'
    : "";
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

function smartProposalYardCode(value) {
  const match = String(value || "").match(/(?:^|\D)(3445|12441|2967|150)(?:\D|$)/);
  return match?.[1] || "";
}

function smartProposalDestinationPriority(proposal = {}) {
  const ranks = smartProposalStops(proposal)
    .map((stop) => SMART_PROPOSAL_YARD_RANK.get(smartProposalYardCode(stop.name)))
    .filter(Number.isInteger);
  return ranks.length ? Math.min(...ranks) : SMART_PROPOSAL_YARD_SEQUENCE.length;
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

const smartManualLoadState = {
  open: false,
  proposalType: "TO",
  sourceLocationId: 28,
  destinationLocationId: 26,
  search: "",
  items: [],
  error: ""
};
let smartManualLoadSearchTimer = null;
let smartManualLoadSearchRequest = 0;

function smartProposalYardOptions(selectedLocationId) {
  return smartProposalYards.map((yard) => `<option value="${yard.locationId}" ${Number(selectedLocationId) === yard.locationId ? "selected" : ""}>${yard.name}</option>`).join("");
}

function smartProposalDestinationCalculation(proposal, line, movementLabel = "proposal") {
  const reason = line.reason || {};
  const destinationAllocations = smartProposalDestinationAllocations(line);
  if (destinationAllocations.length > 1) {
    const physicalDestination = line.destinationName || proposal.destinationName || "12441";
    return `<div class="smart-calculation-block smart-destination-calculation">
      <span class="smart-calculation-title"><strong>Grouped yard allocation</strong></span>
      <small>One physical receipt at ${smartEscape(physicalDestination)}; yard demand remains separated for validation and later transfers.</small>
      ${smartProposalAllocationSummary(line)}
    </div>`;
  }
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
  const preferredBelowReorderPoint = hasPolicyDecision && preferred + 0.000001 < reorderPoint;
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
    ${hasPolicyDecision ? `<small>Policy scope: this SKU at <strong>${smartEscape(planningYard)}</strong>; not this proposal line or load.</small><span>Reorder trigger: <strong>${smartNumber(reorderPoint, 2)} PLT</strong></span><span>Preferred target: <strong>${smartNumber(preferred, 2)} PLT</strong></span>` : ""}
    ${preferredBelowReorderPoint ? capacity !== null
      ? `<span class="smart-policy-constraint">Capacity constraint: <strong>${smartNumber(capacity, 2)} PLT</strong> capacity is below <strong>${smartNumber(reorderPoint, 2)} PLT</strong> ROP, so this SKU-yard's preferred target is capped at ${smartNumber(preferred, 2)} PLT.</span>`
      : `<span class="smart-policy-constraint">Policy warning: preferred target is below ROP and the saved capacity is unavailable.</span>` : ""}
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
  const manualSourceFloorOverride = reason.manualSourceFloorOverride === true
    || reason.manuallyAdjusted === true
    || reason.manuallyAdded === true
    || reason.manualLoad === true;
  const sourceAvailable = smartReasonNumber(reason, "sourceAvailablePallets");
  const sourceSafety = smartReasonNumber(reason, "sourceSafetyStockPallets");
  const sourceRop = smartReasonNumber(reason, "sourceReorderPointPallets");
  const sourcePreferred = smartReasonNumber(reason, "sourcePreferredPallets");
  const sourceStandardSafety = smartReasonNumber(reason, "sourceStandardSafetyStockPallets");
  const sourceStandardRop = smartReasonNumber(reason, "sourceStandardReorderPointPallets");
  const sourceStandardPreferred = smartReasonNumber(reason, "sourceStandardPreferredPallets");
  const storedProtectedFloor = smartReasonNumber(reason, "sourceProtectedFloorPallets");
  const calculatedProtectedFloor = sourceSafety !== null && sourceRop !== null ? Math.max(sourceSafety, sourceRop) : null;
  const storedMaximum = smartReasonNumber(reason, "sourceMaximumTransferablePallets");
  const calculatedMaximum = sourceAvailable !== null && calculatedProtectedFloor !== null
    ? Math.floor(Math.max(0, sourceAvailable - calculatedProtectedFloor) + 0.000001)
    : null;
  const policyMaximumTransferable = calculatedMaximum ?? storedMaximum;
  const usesActualAvailabilityLimit = manualSourceFloorOverride && sourceAvailable !== null;
  const maximumTransferable = usesActualAvailabilityLimit
    ? Math.floor(Math.max(0, sourceAvailable) + 0.000001)
    : policyMaximumTransferable;
  const sourceAfterLine = sourceAvailable === null ? null : sourceAvailable - proposed;
  const hasSourceFormula = sourceAvailable !== null && sourceSafety !== null && sourceRop !== null
    && calculatedProtectedFloor !== null && calculatedMaximum !== null;
  const sourceSnapshotMismatch = (storedProtectedFloor !== null && calculatedProtectedFloor !== null
    && Math.abs(storedProtectedFloor - calculatedProtectedFloor) > 0.000001)
    || (storedMaximum !== null && calculatedMaximum !== null && Math.abs(storedMaximum - calculatedMaximum) > 0.000001);
  const withinLimit = maximumTransferable === null ? null : proposed <= maximumTransferable + 0.000001;
  const sourceLowerStockEvidence = reason.sourceLowerStockPolicyEnabled
    ? reason.sourceLowerStockPolicyApplied
      && sourceStandardSafety !== null
      && sourceStandardRop !== null
      && sourceStandardPreferred !== null
      && sourcePreferred !== null
      ? `<small>Lower stock policy · 1-PLT floor: Safety ${smartNumber(sourceStandardSafety, 3)} → ${smartNumber(sourceSafety, 3)} PLT · ROP ${smartNumber(sourceStandardRop, 2)} → ${smartNumber(sourceRop, 2)} PLT · Preferred ${smartNumber(sourceStandardPreferred, 2)} → ${smartNumber(sourcePreferred, 2)} PLT.</small>`
      : "<small>Lower stock policy · 1-PLT floor enabled; active demand/floor rules leave this source policy unchanged.</small>"
    : "";
  return `<div class="smart-calculation-block smart-source-calculation">
    <span class="smart-calculation-title"><strong>${smartEscape(proposal.sourceName || "Source yard")} source protection</strong></span>
    <small>Plan-time snapshot; confirmation rechecks live source inventory.</small>
    ${sourceLowerStockEvidence}
    <span>Available after active reservations: <strong>${smartOptionalNumber(sourceAvailable, 2)} PLT</strong></span>
    ${hasSourceFormula ? `<span>Safety stock: <strong>${smartNumber(sourceSafety, 2)} PLT</strong> · ROP: <strong>${smartNumber(sourceRop, 2)} PLT</strong></span>
    <small>Protected floor = max(${smartNumber(sourceSafety, 2)} safety stock, ${smartNumber(sourceRop, 2)} ROP) = ${smartNumber(calculatedProtectedFloor, 2)} PLT</small>
    <small>Maximum transferable = floor(max(0, ${smartNumber(sourceAvailable, 2)} available − ${smartNumber(calculatedProtectedFloor, 2)} protected)) = ${smartNumber(calculatedMaximum, 2)} PLT</small>`
      : policyMaximumTransferable !== null ? `<small>Captured source transfer limit: ${smartNumber(policyMaximumTransferable, 2)} PLT; formula inputs are unavailable.</small>` : ""}
    ${manualSourceFloorOverride ? `<span class="smart-replenishment-equation">User-entered quantity overrides the safety stock / ROP floor; actual unreserved source stock remains the limit.</span>` : ""}
    ${usesActualAvailabilityLimit && policyMaximumTransferable === null ? `<span class="smart-replenishment-equation">Source safety/ROP calculation was not captured for this manual or legacy line.</span>` : ""}
    ${sourceSnapshotMismatch ? `<span class="smart-replenishment-equation"><strong>Saved source-limit fields are inconsistent; refresh and replan before confirmation.</strong></span>` : ""}
    ${withinLimit === null
      ? `<span class="smart-replenishment-equation">Source safety/ROP calculation was not captured for this manual or legacy line.</span>`
      : `<span class="smart-replenishment-equation">${smartNumber(proposed, 2)} PLT ${usesActualAvailabilityLimit ? "user-entered transfer" : "transfer"} ≤ ${smartNumber(maximumTransferable, 2)} PLT ${usesActualAvailabilityLimit ? "actual available" : hasSourceFormula ? "calculated" : "captured"} limit → <strong>${withinLimit ? "within source limit" : usesActualAvailabilityLimit ? "exceeds actual source availability" : "exceeds source limit; refresh and replan"}</strong></span>`}
    <span>Source after this TO line: <strong>${smartOptionalNumber(sourceAfterLine, 2)} PLT</strong></span>
  </div>`;
}

function smartProposalInventory(proposal, line) {
  const destination = smartProposalDestinationCalculation(proposal, line, proposal.proposalType === "TO" ? "TO line" : "proposal");
  return `<div class="smart-inventory-context smart-replenishment-calculation">${proposal.proposalType === "TO" ? smartProposalSourceCalculation(proposal, line) : ""}${destination}</div>`;
}

function smartProposalDestinationAvailablePallets(line) {
  const reason = line.reason || {};
  const captured = smartReasonNumber(reason, "destinationAvailablePallets")
    ?? smartReasonNumber(reason, "availablePallets");
  if (captured !== null) return captured;
  const toPlt = smartReasonNumber(line, "toPlt");
  const available = smartReasonNumber(reason, "quantityAvailable");
  const reserved = smartReasonNumber(reason, "quantityReservedOutbound") ?? 0;
  if (toPlt === null || toPlt <= 0 || available === null) return null;
  return Math.max(0, available - reserved) / toPlt;
}

function smartProposalExpectedInventoryPallets(line) {
  const reason = line.reason || {};
  const toPlt = smartReasonNumber(line, "toPlt");
  const available = smartReasonNumber(reason, "quantityAvailable");
  const onOrder = smartReasonNumber(reason, "quantityOnOrder");
  const backordered = smartReasonNumber(reason, "quantityBackordered");
  if (toPlt !== null && toPlt > 0 && available !== null && onOrder !== null && backordered !== null) {
    return (available + onOrder - backordered) / toPlt;
  }
  return smartReasonNumber(reason, "destinationExpectedAvailablePallets");
}

function smartProposalAvailability(proposal, line) {
  const reason = line.reason || {};
  const destinationAllocations = smartProposalDestinationAllocations(line);
  const hubTag = smartProposalHubAvailabilityTag(proposal, line);
  if (destinationAllocations.length > 1) {
    const physicalDestination = line.destinationName || proposal.destinationName || "Destination";
    return `<div class="smart-availability-summary${smartState.planCompact ? " smart-availability-inline" : ""}">
      ${hubTag}
      <span><small>Physical receipt</small><strong>${smartEscape(physicalDestination)}</strong></span>
      <span><small>Planned allocation</small><strong>${smartNumber(line.proposedPallets, 2)} PLT · ${destinationAllocations.length} yards</strong></span>
    </div>`;
  }
  const destinationName = reason.actualDestinationYard || line.destinationName || proposal.destinationName || "Destination";
  const destinationAvailable = smartProposalDestinationAvailablePallets(line);
  if (proposal.proposalType === "TO") {
    const sourceName = proposal.sourceName || "Source";
    const sourceAvailable = smartReasonNumber(reason, "sourceAvailablePallets");
    if (smartState.planCompact) {
      return `<div class="smart-availability-summary smart-availability-inline">
        ${hubTag}
        <span><small>${smartEscape(sourceName)} source</small><strong>${smartOptionalNumber(sourceAvailable, 2)} PLT</strong></span>
        <span><small>${smartEscape(destinationName)} destination</small><strong>${smartOptionalNumber(destinationAvailable, 2)} PLT</strong></span>
      </div>`;
    }
    return `<div class="smart-availability-summary">
      ${hubTag}
      <span><small>${smartEscape(sourceName)} source available</small><strong>${smartOptionalNumber(sourceAvailable, 2)} PLT</strong></span>
      <span><small>${smartEscape(destinationName)} destination available</small><strong>${smartOptionalNumber(destinationAvailable, 2)} PLT</strong></span>
    </div>`;
  }
  const expected = smartProposalExpectedInventoryPallets(line);
  if (smartState.planCompact) {
    return `<div class="smart-availability-summary smart-availability-inline">
      ${hubTag}
      <span><small>${smartEscape(destinationName)} available</small><strong>${smartOptionalNumber(destinationAvailable, 2)} PLT</strong></span>
      <span><small>Expected</small><strong>${smartOptionalNumber(expected, 2)} PLT</strong></span>
    </div>`;
  }
  return `<div class="smart-availability-summary">
    ${hubTag}
    <span><small>${smartEscape(destinationName)} available</small><strong>${smartOptionalNumber(destinationAvailable, 2)} PLT</strong></span>
    <span><small>Expected inventory · AA + OO − BO</small><strong>${smartOptionalNumber(expected, 2)} PLT</strong></span>
  </div>`;
}

function smartProposalDecisionEvidence(line) {
  const reason = line.reason || {};
  const destinationAllocations = smartProposalDestinationAllocations(line);
  if (destinationAllocations.length > 1) {
    return `<div class="smart-reason"><span>Grouped physical receipt; each yard allocation is validated against its own ROP and preferred stock level.</span></div>`;
  }
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
  if (reason.lowerStockPolicyEnabled && !destinationPolicyInvalid) {
    const standardSafety = smartReasonNumber(reason, "standardSafetyStockPallets");
    const standardRop = smartReasonNumber(reason, "standardReorderPointPallets");
    const standardPreferred = smartReasonNumber(reason, "standardPreferredPallets");
    if (reason.lowerStockPolicyApplied
      && standardSafety !== null
      && standardRop !== null
      && standardPreferred !== null) {
      labels.push(`<span>Lower stock policy · 1-PLT floor · Safety ${smartNumber(standardSafety, 3)} → ${smartNumber(reason.safetyStockPallets, 3)} · ROP ${smartNumber(standardRop, 2)} → ${smartNumber(reason.reorderPointPallets, 2)} · Preferred ${smartNumber(standardPreferred, 2)} → ${smartNumber(reason.preferredPallets, 2)} PLT</span>`);
    } else {
      labels.push("<span>Lower stock policy · 1-PLT floor enabled · levels unchanged by active demand/floor rules</span>");
    }
  }
  if (reason.forecastModel && !destinationPolicyInvalid) labels.push(`<span>Forecast: ${smartEscape(reason.forecastModel)}</span>`);
  if (reason.vendorSupplyStatus) labels.push(`<span>Vendor supply: ${smartEscape(reason.vendorSupplyStatus)}</span>`);
  if (reason.vendorConfirmationRequired) labels.push("<span>Vendor confirmation required</span>");
  if (reason.importedVendorAvailablePallets !== null && reason.importedVendorAvailablePallets !== undefined
    && Number.isFinite(Number(reason.importedVendorAvailablePallets))) {
    labels.push(`<span>Imported vendor available: ${smartNumber(reason.importedVendorAvailablePallets, 2)} PLT</span>`);
  }
  if (reason.zeroDemandCoverageApplied && !destinationPolicyInvalid) labels.push(`<span>Coverage floor: ${smartNumber(reason.coverageFloorPallets, 2)} PLT · ${smartEscape(reason.coverageSource || "unknown")}</span>`);
  const stockoutDemandMethod = reason.stockoutDemandMethod || reason.demandEvidenceMethod || reason.formulaDemandMethod;
  if (stockoutDemandMethod && stockoutDemandMethod !== "none" && !destinationPolicyInvalid) {
    const methodLabels = {
      snapshot: "inventory snapshots",
      mixed: "snapshots + positive-sales proxy",
      positive_sales_proxy: "positive-sales proxy"
    };
    const snapshotWeeks = smartReasonNumber(reason, "stockoutSnapshotWeeks") ?? smartReasonNumber(reason, "snapshotWeekCount");
    const proxyWeeks = smartReasonNumber(reason, "stockoutProxyWeeks") ?? smartReasonNumber(reason, "proxyWeekCount");
    const explicitEligibleWeeks = smartReasonNumber(reason, "stockoutEligibleWeeks") ?? smartReasonNumber(reason, "eligibleWeekCount");
    const eligibleWeeks = explicitEligibleWeeks ?? (snapshotWeeks !== null || proxyWeeks !== null ? (snapshotWeeks || 0) + (proxyWeeks || 0) : null);
    const historyStart = reason.stockoutEvidenceStartWeek || reason.stockoutHistoryStart || reason.historyStart;
    const historyEnd = reason.stockoutEvidenceEndWeek || reason.stockoutHistoryEnd || reason.historyEnd;
    const confidence = reason.stockoutDemandConfidence;
    labels.push(`<span>Stockout demand: ${smartEscape(methodLabels[stockoutDemandMethod] || String(stockoutDemandMethod).replaceAll("_", " "))}${confidence ? ` · ${smartEscape(confidence)} confidence` : ""}${eligibleWeeks !== null ? ` · ${smartNumber(eligibleWeeks, 0)} eligible weeks` : ""}${snapshotWeeks !== null ? ` · ${smartNumber(snapshotWeeks, 0)} snapshot` : ""}${proxyWeeks !== null ? ` · ${smartNumber(proxyWeeks, 0)} proxy` : ""}${historyStart || historyEnd ? ` · ${smartEscape(historyStart || "?")} to ${smartEscape(historyEnd || "?")}` : ""}${reason.demandDataCutoff ? ` · sales cutoff ${smartEscape(reason.demandDataCutoff)}` : ""}</span>`);
  }
  const urgencyLevel = smartLineUrgencyLevel(line);
  if (urgencyLevel !== "normal") {
    const urgencyScore = smartReasonNumber(line, "urgencyScore") ?? smartReasonNumber(reason, "urgencyScore");
    labels.push(`<span>Urgency: ${smartEscape(smartUrgencyLabel(urgencyLevel))}${urgencyScore !== null ? ` · score ${smartNumber(urgencyScore, 1)}` : ""}</span>`);
  }
  if (reason.provisional) labels.push("<span>Provisional</span>");
  return `<div class="smart-reason">${labels.join("")}</div>`;
}

function smartProposalColumnControls() {
  return `<div class="smart-proposal-view-controls" role="group" aria-label="Proposal table view">
    <button class="smart-button ${smartState.planCompact ? "active" : ""}" data-smart-action="proposal-view" data-smart-proposal-view="compact" type="button" aria-pressed="${smartState.planCompact}">Compact</button>
    <button class="smart-button ${smartState.planCompact ? "" : "active"}" data-smart-action="proposal-view" data-smart-proposal-view="detailed" type="button" aria-pressed="${!smartState.planCompact}">Detailed</button>
  </div>${smartState.planCompact ? "" : `<fieldset class="smart-proposal-column-controls">
    <legend>Show columns</legend>
    <label><input data-smart-plan-detail="inventory" type="checkbox" ${smartState.planShowInventory ? "checked" : ""} data-smart-focus-key="proposal-view:inventory-column" /><span>Inventory calculation</span></label>
    <label><input data-smart-plan-detail="decision-evidence" type="checkbox" ${smartState.planShowDecisionEvidence ? "checked" : ""} data-smart-focus-key="proposal-view:decision-evidence-column" /><span>Decision evidence</span></label>
  </fieldset>`}`;
}

function smartProposalDetailClassName() {
  if (smartState.planCompact) return " smart-proposal-lines-compact";
  const hiddenCount = Number(!smartState.planShowInventory) + Number(!smartState.planShowDecisionEvidence);
  if (hiddenCount === 2) return " smart-proposal-lines-details-hidden";
  if (hiddenCount === 1) return " smart-proposal-lines-one-detail-hidden";
  return "";
}

function smartApplyProposalColumnVisibility(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  const visibility = {
    inventory: !smartState.planCompact && smartState.planShowInventory,
    "decision-evidence": !smartState.planCompact && smartState.planShowDecisionEvidence
  };
  Object.entries(visibility).forEach(([column, visible]) => {
    root.querySelectorAll(`[data-smart-plan-column="${column}"]`).forEach((cell) => { cell.hidden = !visible; });
  });
  root.querySelectorAll(".smart-proposal-lines").forEach((wrapper) => {
    const hiddenCount = Number(!smartState.planShowInventory) + Number(!smartState.planShowDecisionEvidence);
    wrapper.classList.toggle("smart-proposal-lines-one-detail-hidden", !smartState.planCompact && hiddenCount === 1);
    wrapper.classList.toggle("smart-proposal-lines-details-hidden", !smartState.planCompact && hiddenCount === 2);
    wrapper.classList.toggle("smart-proposal-lines-compact", smartState.planCompact);
  });
}

smartFilteredProposals = function smartFilteredProposalsV2() {
  const search = smartState.planSearch.trim().toLowerCase();
  const proposals = (smartState.plan?.proposals || []).filter((proposal) => {
    if (smartState.planType && proposal.proposalType !== smartState.planType) return false;
    if (smartState.planStatus && proposal.status !== smartState.planStatus) return false;
    if (smartState.planSource && (proposal.sourceName || proposal.vendor || "") !== smartState.planSource) return false;
    if (smartState.planVendor && (proposal.proposalType !== "PO"
      || smartNormalizedVendor(smartProposalVendor(proposal)) !== smartState.planVendor)) return false;
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
  return proposals.sort((left, right) => smartUrgencyRank(smartProposalUrgencyLevel(right)) - smartUrgencyRank(smartProposalUrgencyLevel(left))
    || smartProposalDestinationPriority(left) - smartProposalDestinationPriority(right)
    || smartProposalUrgencyScore(right) - smartProposalUrgencyScore(left)
    || primary(left).localeCompare(primary(right), undefined, { numeric: true })
    || secondary(left).localeCompare(secondary(right), undefined, { numeric: true }) || left.id - right.id);
};

function smartProposalLineRow(proposal, line, editable) {
  const inventoryHidden = !smartState.planCompact && smartState.planShowInventory ? "" : " hidden";
  const evidenceHidden = !smartState.planCompact && smartState.planShowDecisionEvidence ? "" : " hidden";
  const urgencyLevel = smartLineUrgencyLevel(line);
  const urgencyLabel = smartUrgencyLabel(urgencyLevel);
  const allocationSummary = smartProposalAllocationSummary(line);
  const itemContent = smartState.planCompact
    ? `<strong>${smartEscape(line.itemName)}</strong><span class="smart-sr-only">${smartEscape(urgencyLabel)} urgency.</span>${allocationSummary}`
    : `<strong>${smartEscape(line.itemName)}</strong><div class="smart-help">ID ${line.itemId} · ${smartEscape(line.itemDescription || line.unit || "")}</div><div class="smart-line-flags">${urgencyLevel !== "normal" ? smartPill("attention", urgencyLabel) : ""}${line.provisional ? smartPill("held", "Provisional") : ""}${line.reason?.gormleyHubRedirected ? smartPill("held", `Gormley hub for ${smartEscape((line.reason.gormleyOriginalDestinations || [line.reason.actualDestinationYard]).filter(Boolean).join(", "))}`) : ""}${Number(line.reason?.groupingDeferredPallets) > 0 ? smartPill("held", `${smartNumber(line.reason.groupingDeferredPallets, 0)} PLT deferred`) : ""}${line.manualPlanningRequired ? smartPill("attention", "Missing conversion / weight") : ""}</div>${allocationSummary}`;
  return `<tr class="smart-urgency-${urgencyLevel}" data-smart-urgency="${urgencyLevel}" data-smart-proposal-line="${line.id}" aria-label="${smartEscape(line.itemName)}. ${smartEscape(urgencyLabel)} urgency.">
    <td>${itemContent}</td>
    <td>${editable && proposal.proposalType === "PO" ? `<select class="smart-line-destination-select" data-smart-proposal-destination data-smart-focus-key="proposal:${smartEscape(proposal.id)}:line:${smartEscape(line.id)}:destination" aria-label="Line destination yard">${smartProposalYardOptions(line.destinationLocationId || proposal.destinationLocationId)}</select>` : `<strong>${smartEscape(line.destinationName || proposal.destinationName)}</strong>`}</td>
    <td class="numeric">${smartNumber(line.requiredPallets, 2)} PLT</td>
    <td>${editable ? `<div class="smart-line-quantity"><input data-smart-proposal-pallets data-smart-focus-key="proposal:${smartEscape(proposal.id)}:line:${smartEscape(line.id)}:pallets" type="number" min="1" step="1" value="${smartEscape(Math.max(1, Math.round(line.proposedPallets)))}" /><span>PLT</span><button class="smart-button" data-smart-action="save-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Save</button>${Number.isInteger(Number(line.proposedPallets)) && Number(line.proposedPallets) > 0 ? `<button class="smart-button" data-smart-action="split-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" data-current-pallets="${line.proposedPallets}" type="button">Split to load</button>` : ""}<button class="smart-button danger" data-smart-action="remove-proposal-line" data-proposal-id="${proposal.id}" data-line-id="${line.id}" type="button">Remove</button></div>` : `<strong>${smartNumber(line.proposedPallets, 0)} PLT</strong>`}</td>
    <td class="numeric">${smartNumber(line.salesQuantity, 3)} ${smartEscape(line.unit || "UOM")}</td>
    <td class="numeric">${smartNumber(line.lineWeightLbs, 0)} lb</td>
    <td data-smart-plan-column="availability">${smartProposalAvailability(proposal, line)}</td>
    <td data-smart-plan-column="inventory"${inventoryHidden}>${smartProposalInventory(proposal, line)}</td>
    <td data-smart-plan-column="decision-evidence"${evidenceHidden}>${smartCoverageEvidence(line)}${smartProposalDecisionEvidence(line)}</td>
  </tr>`;
}

function smartPhysicalPalletLineRow(proposal, line, editable) {
  const inventoryHidden = !smartState.planCompact && smartState.planShowInventory ? "" : " hidden";
  const evidenceHidden = !smartState.planCompact && smartState.planShowDecisionEvidence ? "" : " hidden";
  const quantity = Number(line.quantity ?? line.salesQuantity ?? 0);
  const automaticQuantity = Number(line.automaticQuantity ?? quantity);
  const unit = line.unit || "EACH";
  const itemWeight = Number(line.itemWeightLbs || 0);
  const lineWeight = Number(line.lineWeightLbs || 0);
  return `<tr class="smart-physical-pallet-line" data-smart-physical-pallet-line="${smartEscape(line.id)}">
    <td>${smartState.planCompact
      ? `<strong>${smartEscape(line.itemName || "PALLET")}</strong><span class="smart-sr-only">Ancillary packaging item.</span>`
      : `<strong>${smartEscape(line.itemName || "PALLET")}</strong> ${smartPill("reviewed", "Official PALLET")} ${line.overridden ? smartPill("attention", "Manual override") : smartPill("reviewed", "Automatic")}<div class="smart-help">${line.itemId ? `ID ${smartEscape(line.itemId)} · ` : ""}Official ancillary item; saved separately from material PLT</div>`}</td>
    <td><strong>${smartEscape(line.destinationName || "—")}</strong></td>
    <td class="numeric">${smartNumber(automaticQuantity, 2)} ${smartEscape(unit)}<div class="smart-help">Automatic from material PLT</div></td>
    <td>${editable ? `<div class="smart-line-quantity"><input data-smart-pallet-quantity data-smart-focus-key="proposal:${smartEscape(proposal.id)}:pallet-destination:${smartEscape(line.destinationLocationId)}:quantity" type="number" min="0" step="0.01" value="${smartEscape(quantity)}" aria-label="Official PALLET quantity for ${smartEscape(line.destinationName || "destination")}" /><span>${smartEscape(unit)}</span><button class="smart-button" data-smart-action="save-pallet-line" data-proposal-id="${proposal.id}" data-destination-location-id="${line.destinationLocationId}" type="button">Save</button>${line.overridden ? `<button class="smart-button" data-smart-action="reset-pallet-line" data-proposal-id="${proposal.id}" data-destination-location-id="${line.destinationLocationId}" type="button">Reset auto</button>` : ""}</div>` : `<strong>${smartNumber(quantity, 2)} ${smartEscape(unit)}</strong><div class="smart-help">${line.overridden ? "Manual override" : "Automatic"}</div>`}</td>
    <td class="numeric">${smartNumber(quantity, 2)} ${smartEscape(unit)}</td>
    <td class="numeric">${itemWeight > 0 ? `<strong>${smartNumber(lineWeight, 0)} lb</strong><div class="smart-help">${smartNumber(itemWeight, 0)} lb / ${smartEscape(unit)} · NetSuite</div>` : `<span class="smart-help">NetSuite weight unavailable</span>`}</td>
    <td data-smart-plan-column="availability"><span class="smart-help">Ancillary packaging item</span></td>
    <td data-smart-plan-column="inventory"${inventoryHidden}><span class="smart-help">Physical packaging item; its weight is included, but it does not add another PLT to the load count.</span></td>
    <td data-smart-plan-column="decision-evidence"${evidenceHidden}><span class="smart-help">Automatic: ${smartNumber(automaticQuantity, 2)}. Effective: ${smartNumber(quantity, 2)}. The effective quantity continues through Vendor Replies and is inserted into NetSuite once.</span></td>
  </tr>`;
}

function smartProposalLineEditor(proposal) {
  if (!smartProposalEditable(proposal)) return "";
  return `<div class="smart-proposal-line-editor" data-smart-line-editor="${proposal.id}">
    <div class="smart-proposal-line-editor-controls">
      <strong>Add line</strong>
      ${proposal.proposalType === "PO"
        ? `<label class="smart-proposal-line-destination"><span>To</span><select data-smart-line-destination data-smart-focus-key="proposal:${smartEscape(proposal.id)}:add-line:destination" aria-label="Destination yard">${smartProposalYardOptions(proposal.destinationLocationId)}</select></label>`
        : `<span class="smart-proposal-line-destination smart-proposal-line-destination-static"><span>To</span><strong>${smartEscape(proposal.destinationName)}</strong></span>`}
      <input data-smart-line-search="${proposal.id}" data-smart-focus-key="proposal:${smartEscape(proposal.id)}:add-line:search" type="search" placeholder="Search item ID, name, or description" aria-label="Search item to add" autocomplete="off" />
    </div>
    <div class="smart-proposal-item-results" data-smart-line-results="${proposal.id}" aria-live="polite"></div>
  </div>`;
}

smartProposalCard = function smartProposalCardV2(proposal) {
  const isPo = proposal.proposalType === "PO";
  const overCapacity = Number(proposal.utilization) > 1.000001;
  const urgencyLevel = smartProposalUrgencyLevel(proposal);
  const urgencyLabel = smartUrgencyLabel(urgencyLevel);
  const executionRef = isPo ? proposal.netsuitePurchaseOrderRef : proposal.netsuiteTransferOrderRef;
  const hasExecutionReference = Boolean(isPo
    ? (proposal.netsuitePurchaseOrderId || proposal.netsuitePurchaseOrderRef)
    : (proposal.netsuiteTransferOrderId || proposal.netsuiteTransferOrderRef));
  const locked = hasExecutionReference || ["confirmed", "executing", "completed", "superseded", "cancelled"].includes(proposal.status);
  const editable = smartProposalEditable(proposal);
  const canConfirm = !hasExecutionReference && !isPo && ["draft", "reviewed", "executing", "failed", "attention"].includes(proposal.status);
  const confirmTransferLabel = ["executing", "failed", "attention"].includes(proposal.status)
    ? "Retry TO + print"
    : "Confirm TO + print";
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
  const capacityAttention = overCapacity
    ? smartPill("attention", isPo ? "Needs Re-Calculate" : "Over capacity · manual")
    : "";
  const recalculatePo = editable && isPo ? `<button class="smart-button blue" data-smart-action="recalculate-po" data-proposal-id="${proposal.id}" type="button">Re-Calculate PO</button>` : "";
  return `<article class="smart-proposal ${selected ? "selected" : ""}" data-smart-proposal="${proposal.id}" data-smart-urgency="${urgencyLevel}">
    <div class="smart-proposal-head">
      <div class="smart-proposal-identity">${editable ? `<label class="smart-proposal-select"><input data-smart-proposal-select="${proposal.id}" data-smart-focus-key="proposal:${smartEscape(proposal.id)}:group-selected" type="checkbox" ${selected ? "checked" : ""} /><span>Group</span></label>` : ""}<strong class="smart-proposal-type">${smartEscape(proposal.proposalType)}</strong><div class="smart-proposal-badges">${smartPill(proposal.status)}${urgencyLevel !== "normal" ? smartPill("attention", urgencyLabel) : ""}${capacityAttention}</div></div>
      <div class="smart-proposal-route"><strong>${smartEscape(smartProposalRoute(proposal))}</strong><span>#${proposal.id} · ${smartEscape(proposal.phase.replaceAll("_", " "))}${proposal.manuallyGrouped ? " · manually grouped" : ""}</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalPallets, 0)} PLT</strong><span>Pallets</span></div>
      <div class="smart-proposal-metric"><strong>${smartNumber(proposal.totalWeightLbs, 0)} lb</strong><span>${smartPercent(proposal.utilization, 0)} truck</span></div>
      <div class="smart-proposal-metric"><strong>${executionRef ? smartEscape(executionRef) : "—"}</strong><span>${isPo ? "PO load ref" : "NetSuite TO"}</span></div>
      <div class="smart-actions">${recalculatePo}${actions}${smartCanWrite() && canConfirm ? `<button class="smart-button primary" data-smart-action="confirm-transfer" data-proposal-id="${proposal.id}" type="button">${confirmTransferLabel}</button>` : ""}${smartCanWrite() && !isPo && hasExecutionReference && proposal.status === "attention" ? `<button class="smart-button warn" data-smart-action="retry-picking-ticket" data-proposal-id="${proposal.id}" type="button">Retry picking ticket</button>` : ""}</div>
    </div>
    <div class="smart-proposal-lines smart-table-wrap${smartProposalDetailClassName()}"><table class="smart-table"><thead><tr><th>Item</th><th>Destination</th><th class="numeric">Required</th><th>Proposed</th><th class="numeric">${smartState.planCompact ? "Sales qty" : "Sales quantity"}</th><th class="numeric">${smartState.planCompact ? "Weight" : "Line weight"}</th><th data-smart-plan-column="availability">Availability</th><th data-smart-plan-column="inventory"${!smartState.planCompact && smartState.planShowInventory ? "" : " hidden"}>Inventory calculation</th><th data-smart-plan-column="decision-evidence"${!smartState.planCompact && smartState.planShowDecisionEvidence ? "" : " hidden"}>Decision evidence</th></tr></thead><tbody>${proposal.lines.map((line) => smartProposalLineRow(proposal, line, editable)).join("")}${(proposal.physicalPalletLines || []).map((line) => smartPhysicalPalletLineRow(proposal, line, editable)).join("")}</tbody></table></div>
    ${smartProposalLineEditor(proposal)}
  </article>`;
};

function smartManualLoadItemResults(items = smartManualLoadState.items) {
  if (!items.length) return `<div class="smart-empty smart-empty-compact">Search for a planning-enabled item for the selected yard route.</div>`;
  return items.map((item) => `<div class="smart-manual-load-item" data-smart-manual-load-item="${item.itemId}">
    <div><strong>${smartEscape(item.itemName)}</strong><div class="smart-help">ID ${item.itemId} · ${smartEscape(item.vendor || item.itemDescription || item.unit || "")} · source ${smartEscape(item.sourceName || "selected yard")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div>
    <label><span>PLT</span><input data-smart-manual-load-pallets data-smart-focus-key="manual-load:item:${smartEscape(item.itemId)}:pallets" type="number" min="1" step="1" value="1" /></label>
    <button class="smart-button primary" data-smart-action="create-manual-load" data-item-id="${item.itemId}" type="button">Create held load</button>
  </div>`).join("");
}

function smartManualLoadPanel(plan) {
  if (!smartManualLoadState.open || !plan) return "";
  const isTo = smartManualLoadState.proposalType === "TO";
  const routeInvalid = isTo && Number(smartManualLoadState.sourceLocationId) === Number(smartManualLoadState.destinationLocationId);
  return `<section class="smart-manual-load-panel" aria-label="Add a manual PO or TO load">
    <div class="smart-manual-load-head"><div><h3>Add load manually</h3><p>The initial line and its conversion define a new held load. Manual quantities may exceed configured truck capacity and will be flagged for review.</p></div><button class="smart-button" data-smart-action="close-manual-load" type="button">Close</button></div>
    <div class="smart-manual-load-fields">
      <label><span>Load type</span><select data-smart-manual-load-field="proposalType" data-smart-focus-key="manual-load:proposal-type"><option value="TO" ${isTo ? "selected" : ""}>Transfer order</option><option value="PO" ${isTo ? "" : "selected"}>Purchase order</option></select></label>
      ${isTo
        ? `<label><span>From yard</span><select data-smart-manual-load-field="sourceLocationId" data-smart-focus-key="manual-load:source-location">${smartProposalYardOptions(smartManualLoadState.sourceLocationId)}</select></label>`
        : `<label><span>Vendor source</span><strong>Derived from selected item</strong></label>`}
      <label><span>To yard</span><select data-smart-manual-load-field="destinationLocationId" data-smart-focus-key="manual-load:destination-location">${smartProposalYardOptions(smartManualLoadState.destinationLocationId)}</select></label>
      <label class="smart-manual-load-search"><span>Initial item</span><input data-smart-manual-load-search data-smart-focus-key="manual-load:item-search" type="search" value="${smartEscape(smartManualLoadState.search)}" placeholder="Item ID, name, or description" autocomplete="off" /></label>
      <button class="smart-button" data-smart-action="search-manual-load-items" type="button" ${routeInvalid ? "disabled" : ""}>Search items</button>
    </div>
    ${routeInvalid ? `<div class="smart-notice error">TO source and destination yards must be different.</div>` : ""}
    ${smartManualLoadState.error ? `<div class="smart-notice error">${smartEscape(smartManualLoadState.error)}</div>` : ""}
    <div class="smart-manual-load-results" data-smart-manual-load-results>${smartManualLoadItemResults()}</div>
  </section>`;
}

function smartUrgencyLegend() {
  return `<div class="smart-urgency-legend" aria-label="Proposal urgency colours">
    ${SMART_URGENCY_LEVELS.map((level) => `<span class="smart-urgency-key smart-urgency-${level}"><i aria-hidden="true"></i>${smartEscape(smartUrgencyLabel(level))}</span>`).join("")}
  </div>`;
}

smartPlans = function smartPlansV2() {
  const plan = smartState.plan;
  const runs = smartState.data.planningRuns || [];
  const all = plan?.proposals || [];
  const proposals = smartFilteredProposals();
  const sources = [...new Set(all.map((proposal) => proposal.sourceName || proposal.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const vendorsByKey = new Map();
  all.filter((proposal) => proposal.proposalType === "PO").forEach((proposal) => {
    const vendor = smartProposalVendor(proposal);
    const key = smartNormalizedVendor(vendor);
    if (key && !vendorsByKey.has(key)) vendorsByKey.set(key, vendor);
  });
  const vendors = [...vendorsByKey.entries()].sort((left, right) => left[1].localeCompare(right[1], undefined, { numeric: true }));
  const destinations = [...new Set(all.flatMap((proposal) => smartProposalStops(proposal).map((stop) => stop.name)).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const selectedCount = smartState.selectedProposalIds.size;
  const exclusionCount = typeof smartPlanningExclusionCount === "function" ? smartPlanningExclusionCount() : 0;
  const exclusionPanel = typeof smartPlanningExclusionPanel === "function" ? smartPlanningExclusionPanel() : "";
  return `<section class="smart-section smart-plan-section">
    <div class="smart-plan-sticky">
    <div class="smart-section-head"><div><h2>PO / TO proposal review</h2><p>Automatic packing respects configured truck capacity. Manual quantities may exceed it and will be flagged; Split moves a line into its own held load.</p></div><div class="smart-actions smart-plan-header-actions">${smartProposalColumnControls()}<button class="smart-button warn" data-smart-action="toggle-planning-exclusions" type="button">Paused items (${smartNumber(exclusionCount, 0)})</button>${smartCanWrite() ? `${plan?.status === "ready" ? `<button class="smart-button" data-smart-action="open-manual-load" type="button">Add load</button>` : ""}<button class="smart-button" data-smart-action="group-proposals" type="button" ${selectedCount < 2 ? "disabled" : ""}>Group selected (${selectedCount})</button><button class="smart-button primary" data-smart-action="run-plan" type="button">Build new plan</button>` : ""}</div></div>
    <div class="smart-toolbar smart-plan-toolbar">
      <select id="smartPlanRun"><option value="">Select a run</option>${runs.map((run) => `<option value="${run.id}" ${Number(plan?.id) === Number(run.id) ? "selected" : ""}>#${run.id} · ${smartDate(run.completedAt, true)} · r${run.revision}</option>`).join("")}</select>
      <input id="smartPlanSearch" type="search" value="${smartEscape(smartState.planSearch)}" placeholder="Item, vendor, yard, or memo" />
      <select id="smartPlanType"><option value="">PO + TO</option><option value="PO" ${smartState.planType === "PO" ? "selected" : ""}>PO only</option><option value="TO" ${smartState.planType === "TO" ? "selected" : ""}>TO only</option></select>
      <select id="smartPlanStatus"><option value="">All statuses</option>${["draft", "held", "order_requested", "vendor_replied", "reviewed", "attention", "executing", "completed", "failed", "superseded", "cancelled"].map((status) => `<option value="${status}" ${smartState.planStatus === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select>
      <select id="smartPlanVendor" aria-label="PO vendor" ${smartState.planType === "TO" ? "hidden disabled" : ""}><option value="">All PO vendors</option>${vendors.map(([key, vendor]) => `<option value="${smartEscape(key)}" ${smartState.planVendor === key ? "selected" : ""}>${smartEscape(vendor)}</option>`).join("")}</select>
      <select id="smartPlanSource"><option value="">All source yards / vendors</option>${sources.map((source) => `<option value="${smartEscape(source)}" ${smartState.planSource === source ? "selected" : ""}>${smartEscape(source)}</option>`).join("")}</select>
      <select id="smartPlanDestination"><option value="">All destination yards</option>${destinations.map((yard) => `<option value="${smartEscape(yard)}" ${smartState.planDestination === yard ? "selected" : ""}>${smartEscape(yard)}</option>`).join("")}</select>
      <select id="smartPlanSort"><option value="destination" ${smartState.planSort === "destination" ? "selected" : ""}>Tie-break: destination route</option><option value="source" ${smartState.planSort === "source" ? "selected" : ""}>Tie-break: source yard / vendor</option></select>
      <button class="smart-button" data-smart-action="filter-plan" type="button">Apply</button><span class="smart-help">${proposals.length} proposal(s)</span>
    </div>
    ${smartUrgencyLegend()}
    </div>
    ${exclusionPanel}
    ${smartManualLoadPanel(plan)}
    ${plan ? `<div class="smart-proposals">${proposals.map(smartProposalCard).join("") || `<div class="smart-empty">No proposal matches this filter.</div>`}</div>` : `<div class="smart-empty">No planning run exists. Configure Item Master, upload sales history, then build a plan; live NetSuite inventory is refreshed automatically.</div>`}
  </section>`;
};

function smartProposalItemResults(proposalId, items = []) {
  if (!items.length) return `<div class="smart-empty smart-empty-compact">No compatible planning item matches.</div>`;
  return items.map((item) => `<div class="smart-proposal-item-result" data-smart-proposal-item="${item.itemId}"><div><strong>${smartEscape(item.itemName)}</strong><div class="smart-help">ID ${item.itemId} · ${smartEscape(item.vendor || item.itemDescription || item.unit || "")} · ${smartNumber(item.palletWeightLbs, 0)} lb / PLT</div></div><label><span>PLT</span><input data-smart-add-pallets data-smart-focus-key="proposal:${smartEscape(proposalId)}:add-item:${smartEscape(item.itemId)}:pallets" type="number" min="1" step="1" value="1" /></label><button class="smart-button primary" data-smart-action="add-proposal-line" data-proposal-id="${proposalId}" data-item-id="${item.itemId}" type="button">Add</button></div>`).join("");
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

async function smartSearchManualLoadItems() {
  const requestId = ++smartManualLoadSearchRequest;
  const target = document.querySelector("[data-smart-manual-load-results]");
  const proposalType = smartManualLoadState.proposalType;
  const sourceLocationId = Number(smartManualLoadState.sourceLocationId);
  const destinationLocationId = Number(smartManualLoadState.destinationLocationId);
  if (proposalType === "TO" && sourceLocationId === destinationLocationId) {
    smartManualLoadState.items = [];
    smartManualLoadState.error = "TO source and destination yards must be different.";
    smartRender();
    return;
  }
  const params = new URLSearchParams({
    proposalType,
    sourceLocationId: String(sourceLocationId),
    destinationLocationId: String(destinationLocationId),
    search: smartManualLoadState.search,
    limit: "12"
  });
  smartManualLoadState.error = "";
  if (target) target.innerHTML = `<span class="smart-help">Finding planning-enabled items for this route…</span>`;
  try {
    const items = await smartApi(`/api/scm/smart/manual-load/items?${params}`);
    if (requestId !== smartManualLoadSearchRequest) return;
    smartManualLoadState.items = Array.isArray(items) ? items : [];
    smartRender();
  } catch (error) {
    if (requestId !== smartManualLoadSearchRequest) return;
    smartManualLoadState.items = [];
    smartManualLoadState.error = error.message;
    smartRender();
  }
}

smartScmApp.addEventListener("change", (event) => {
  if (event.target.id === "smartPlanType") {
    const vendorFilter = document.getElementById("smartPlanVendor");
    const toOnly = event.target.value === "TO";
    if (vendorFilter) {
      vendorFilter.hidden = toOnly;
      vendorFilter.disabled = toOnly;
      if (toOnly) vendorFilter.value = "";
    }
    return;
  }
  const manualLoadField = event.target.dataset.smartManualLoadField;
  if (["proposalType", "sourceLocationId", "destinationLocationId"].includes(manualLoadField)) {
    smartManualLoadState[manualLoadField] = manualLoadField === "proposalType"
      ? event.target.value
      : Number(event.target.value);
    smartManualLoadSearchRequest += 1;
    smartManualLoadState.items = [];
    smartManualLoadState.error = "";
    smartRender();
    return;
  }
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
  if (event.target.dataset.smartManualLoadSearch !== undefined) {
    smartManualLoadState.search = event.target.value;
    smartManualLoadSearchRequest += 1;
    clearTimeout(smartManualLoadSearchTimer);
    smartManualLoadSearchTimer = setTimeout(() => smartSearchManualLoadItems(), 350);
    return;
  }
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
    // The base Smart SCM handler owns filter state and rendering. Keeping this
    // override passive avoids a second render that can disturb control focus.
    return;
  }
  if (action === "proposal-view") {
    smartState.planCompact = button.dataset.smartProposalView !== "detailed";
    smartSaveProposalColumnPreferences();
    smartRender();
    return;
  }
  if (action === "open-manual-load") {
    smartManualLoadState.open = true;
    smartManualLoadState.error = "";
    smartRender();
    return;
  }
  if (action === "close-manual-load") {
    smartManualLoadSearchRequest += 1;
    smartManualLoadState.open = false;
    smartManualLoadState.items = [];
    smartManualLoadState.error = "";
    smartRender();
    return;
  }
  if (action === "search-manual-load-items") {
    await smartSearchManualLoadItems();
    return;
  }
  if (!["group-proposals", "recalculate-po", "save-proposal-line", "save-pallet-line", "reset-pallet-line", "remove-proposal-line", "add-proposal-line", "split-proposal-line", "create-manual-load"].includes(action)) return;
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
    } else if (action === "split-proposal-line") {
      const currentPallets = Number(button.dataset.currentPallets);
      if (!confirm(`Move this entire ${smartNumber(currentPallets, 0)}-PLT item line into its own held load?`)) return;
      smartState.plan = await smartWork(
        "Moving proposal line",
        () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/lines/${button.dataset.lineId}/split`, { method: "POST", body: {} }),
        "Item line moved into a separate held load"
      );
      smartState.selectedProposalIds.delete(Number(button.dataset.proposalId));
      smartRender();
    } else if (action === "save-proposal-line") {
      const row = button.closest("[data-smart-proposal-line]");
      const proposedPallets = Number(row?.querySelector("[data-smart-proposal-pallets]")?.value || 0);
      const destinationLocationId = Number(row?.querySelector("[data-smart-proposal-destination]")?.value || 0) || undefined;
      await smartWork("Updating proposal line", () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/lines/${button.dataset.lineId}`, { method: "PATCH", body: { proposedPallets, destinationLocationId } }), "Proposal line updated");
      smartState.plan = await smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}`);
      smartRender();
    } else if (action === "save-pallet-line" || action === "reset-pallet-line") {
      const row = button.closest("[data-smart-physical-pallet-line]");
      const destinationLocationId = Number(button.dataset.destinationLocationId);
      const reset = action === "reset-pallet-line";
      const rawQuantity = row?.querySelector("[data-smart-pallet-quantity]")?.value?.trim() ?? "";
      if (!reset && rawQuantity === "") throw new Error("Enter a PALLET quantity, or use Reset auto.");
      const quantity = Number(rawQuantity);
      if (!reset && (!Number.isFinite(quantity) || quantity < 0)) throw new Error("PALLET quantity must be zero or greater.");
      await smartWork(
        reset ? "Resetting PALLET quantity" : "Saving PALLET quantity",
        () => smartApi(`/api/scm/smart/proposals/${button.dataset.proposalId}/pallets/${destinationLocationId}`, {
          method: "PATCH",
          body: reset ? { reset: true } : { quantity }
        }),
        reset ? "PALLET quantity returned to Automatic" : "PALLET quantity override saved"
      );
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
    } else if (action === "create-manual-load") {
      if (!smartState.plan?.id) throw new Error("Select a planning run before adding a load.");
      const item = button.closest("[data-smart-manual-load-item]");
      const proposedPallets = Number(item?.querySelector("[data-smart-manual-load-pallets]")?.value || 0);
      const body = {
        proposalType: smartManualLoadState.proposalType,
        sourceLocationId: Number(smartManualLoadState.sourceLocationId),
        destinationLocationId: Number(smartManualLoadState.destinationLocationId),
        itemId: Number(button.dataset.itemId),
        proposedPallets
      };
      smartState.plan = await smartWork(
        "Creating manual load",
        () => smartApi(`/api/scm/smart/planning-runs/${smartState.plan.id}/proposals`, { method: "POST", body }),
        "Manual load created on Hold"
      );
      smartManualLoadState.open = false;
      smartManualLoadState.items = [];
      smartManualLoadState.error = "";
      smartState.selectedProposalIds.clear();
      smartRender();
    }
  } catch (error) {
    smartState.busy = "";
    smartState.error = error.message;
    smartRender();
  }
});

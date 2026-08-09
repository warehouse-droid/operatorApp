import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const smartNumber = (value, places = 1) => {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: places }).format(amount)
    : "—";
};
const smartEscape = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const proposalContext = vm.createContext({
  smartState: {
    planSearch: "", planType: "", planStatus: "", planVendor: "", planSource: "", planDestination: "", planSort: "destination",
    selectedProposalIds: new Set(), plan: null, data: { planningRuns: [] }, busy: ""
  },
  smartCanWrite: () => true,
  smartNumber,
  smartPercent: (value) => `${Math.round(Number(value || 0) * 100)}%`,
  smartDate: (value) => String(value || "date"),
  smartDate: () => "date",
  smartEscape,
  smartPill: () => "",
  smartCoverageEvidence: () => "",
  smartScmApp: { addEventListener() {} },
  smartApi: async () => ({}),
  smartWork: async (_label, action) => action(),
  smartRender() {},
  document: { querySelector: () => null, getElementById: () => null },
  confirm: () => true,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  Map,
  Set,
  Intl
});
vm.runInContext(readPublic("scm-smart-proposals.js"), proposalContext, { filename: "scm-smart-proposals.js" });
vm.runInContext(readPublic("scm-smart-exclusions.js"), proposalContext, { filename: "scm-smart-exclusions.js" });
assert.equal(proposalContext.smartState.planCompact, true, "Compact should be the default proposal view for a new browser.");
proposalContext.smartState.planCompact = false;

const bh80Reason = {
  preferredPallets: 16,
  capacityPallets: 16,
  quantityBackordered: 0,
  positionPallets: 10,
  actualDestinationYard: "150",
  reorderPointPallets: 11,
  quantityAvailable: 0,
  quantityReservedOutbound: 0,
  quantityOnOrder: 816,
  weeklyDemandPallets: 4,
  safetyStockPallets: 3.002221,
  minimumOrderPallets: 3,
  weeksOfCover: 2.5,
  forecastModel: "formula",
  vendorSupplyStatus: "available",
  vendorConfirmationRequired: true,
  importedVendorAvailablePallets: 243,
  coverageSource: "local_item_blend",
  zeroDemandCoverageApplied: false
};
const bh80Line = {
  toPlt: 81.6,
  destinationName: "12441",
  requiredPallets: 6,
  proposedPallets: 6,
  reason: bh80Reason
};
const bh80Html = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "12441" }, bh80Line);
assert.match(bh80Html, /<strong>150 destination need<\/strong>/, "A vendor-hub line must name the actual planning yard.");
assert.match(bh80Html, /Projected position before recommendation: <strong>10 PLT<\/strong>/);
assert.match(bh80Html, /0 available \+ 10 on order − 0 backorder − 0 reserved = 10 PLT/);
assert.match(bh80Html, /Reorder trigger: <strong>11 PLT<\/strong>/);
assert.match(bh80Html, /Preferred target: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /10 &lt; ROP 11 → target gap 6 PLT → <strong>6 PLT destination policy need<\/strong>/);
assert.match(bh80Html, /After current 6-PLT proposal: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /Saved rule: min\(ceil\(max\(6 target gap, 3 minimum order\)\), floor\(16 capacity − 10 position\)\) = 6 PLT/);

const bh80AvailabilityHtml = proposalContext.smartProposalAvailability(
  { proposalType: "PO", destinationName: "12441" },
  bh80Line
);
assert.match(
  bh80AvailabilityHtml,
  /class="smart-availability-hub-tag"[^>]*>HUB<\/span>/,
  "A PO physically received at the hub for another yard must show HUB in Availability."
);
assert.match(bh80AvailabilityHtml, /<small>150 available<\/small><strong>0 PLT<\/strong>/);
assert.match(bh80AvailabilityHtml, /Expected inventory · AA \+ OO − BO/);
assert.match(bh80AvailabilityHtml, /<strong>10 PLT<\/strong>/);

const directPoAvailabilityHtml = proposalContext.smartProposalAvailability(
  { proposalType: "PO", phase: "direct_vendor", destinationName: "12441" },
  {
    ...bh80Line,
    reason: { ...bh80Reason, actualDestinationYard: "12441" }
  }
);
assert.doesNotMatch(
  directPoAvailabilityHtml,
  /smart-availability-hub-tag/,
  "A vendor-direct PO line for the physical destination must not be labeled HUB."
);

const capacityConstrainedHtml = proposalContext.smartProposalInventory(
  { proposalType: "PO", phase: "direct_vendor", destinationName: "12441" },
  {
    ...bh80Line,
    requiredPallets: 25,
    proposedPallets: 25,
    reason: {
      ...bh80Reason,
      actualDestinationYard: "12441",
      positionPallets: 0,
      reorderPointPallets: 32,
      preferredPallets: 25,
      capacityPallets: 25,
      minimumOrderPallets: 6,
      quantityAvailable: 0,
      quantityOnOrder: 0
    }
  }
);
assert.match(
  capacityConstrainedHtml,
  /Policy scope: this SKU at <strong>12441<\/strong>/,
  "The proposal explanation must identify ROP and preferred target as SKU-yard policy values."
);
assert.match(
  capacityConstrainedHtml,
  /Capacity constraint: <strong>25 PLT<\/strong> capacity is below <strong>32 PLT<\/strong> ROP/,
  "A preferred target below ROP must explicitly explain the binding SKU-yard capacity."
);

const groupedHubLine = {
  ...bh80Line,
  requiredPallets: 3,
  proposedPallets: 3,
  reason: {
    ...bh80Reason,
    actualDestinationYard: null,
    destinationAllocations: [
      { yard: "12441", proposedPallets: 2, fulfillment: "vendor_direct" },
      { yard: "3445", proposedPallets: 1, fulfillment: "transfer_later" }
    ]
  }
};
const groupedAllocationHtml = proposalContext.smartProposalAllocationSummary(groupedHubLine);
assert.match(groupedAllocationHtml, /12441[^<]*<\/strong> · Vendor direct · 2 PLT/);
assert.match(groupedAllocationHtml, /3445[^<]*<\/strong> · Transfer later · 1 PLT/);
const groupedInventoryHtml = proposalContext.smartProposalInventory(
  { proposalType: "PO", destinationName: "12441" },
  groupedHubLine
);
assert.match(groupedInventoryHtml, /Grouped yard allocation/);
assert.match(groupedInventoryHtml, /One physical receipt at 12441/);
assert.doesNotMatch(groupedInventoryHtml, /saved snapshot rule calculates/i,
  "A grouped multi-yard line must not display one yard's policy snapshot as if it covered the whole line.");
assert.match(
  proposalContext.smartProposalAvailability(
    { proposalType: "PO", phase: "direct_vendor", destinationName: "12441" },
    groupedHubLine
  ),
  /class="smart-availability-hub-tag"[^>]*>HUB<\/span>/,
  "A grouped physical receipt with any transfer-later allocation must show HUB in Availability."
);
const reservedPoAvailabilityHtml = proposalContext.smartProposalAvailability(
  { proposalType: "PO", destinationName: "2967" },
  {
    ...bh80Line,
    toPlt: 30,
    destinationName: "2967",
    reason: {
      quantityAvailable: 120,
      quantityOnOrder: 60,
      quantityBackordered: 30,
      quantityReservedOutbound: 90
    }
  }
);
assert.match(
  reservedPoAvailabilityHtml,
  /<small>2967 available<\/small><strong>1 PLT<\/strong>/,
  "Destination availability should remain the usable amount after active reservations."
);
assert.match(
  reservedPoAvailabilityHtml,
  /Expected inventory · AA \+ OO − BO<\/small><strong>5 PLT<\/strong>/,
  "PO expected inventory must use AA + OO - BO without subtracting active reservations."
);

const reorderedReason = Object.fromEntries(Object.entries(bh80Reason).reverse());
assert.equal(
  proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "12441" }, { ...bh80Line, reason: reorderedReason }),
  bh80Html,
  "Calculation output must not depend on JSON property order."
);
const noTriggerHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 0,
  proposedPallets: 0,
  reason: { ...bh80Reason, positionPallets: 11 }
});
assert.match(noTriggerHtml, /11 ≥ ROP 11 → <strong>no automatic replenishment trigger<\/strong>/);
assert.doesNotMatch(noTriggerHtml, /Saved rule:/, "A non-trigger state must not claim an order rule.");
const atTargetHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 0,
  proposedPallets: 0,
  reason: { ...bh80Reason, positionPallets: 16 }
});
assert.match(atTargetHtml, /16 ≥ ROP 11 → <strong>no automatic replenishment trigger<\/strong>/);
assert.doesNotMatch(atTargetHtml, /Saved rule:/, "A no-trigger state at preferred stock must not claim an MOQ order.");
const moqBindingHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 3,
  proposedPallets: 3,
  reason: {
    ...bh80Reason,
    positionPallets: 2.5,
    reorderPointPallets: 3,
    preferredPallets: 4,
    minimumOrderPallets: 3,
    capacityPallets: 10
  }
});
assert.match(moqBindingHtml, /2\.5 &lt; ROP 3 → target gap 1\.5 PLT → <strong>3 PLT destination policy need<\/strong>/);
assert.match(moqBindingHtml, /Saved rule: min\(ceil\(max\(1\.5 target gap, 3 minimum order\)\), floor\(10 capacity − 2\.5 position\)\) = 3 PLT/);
assert.doesNotMatch(moqBindingHtml, /order up to 4/, "An MOQ-bound recommendation must not claim it stops at the preferred level.");
const historicalMovedLine = {
  ...bh80Line,
  destinationName: "2967",
  reason: {
    ...bh80Reason,
    destinationManuallyAdjusted: true,
    manuallyAdjusted: true,
    quantityAvailable: 81.6,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0
  }
};
const historicalMovedHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "2967" }, historicalMovedLine);
assert.match(historicalMovedHtml, /Destination changed after planning; build a new plan to calculate this yard's policy need/);
assert.doesNotMatch(historicalMovedHtml, /Reorder trigger:/, "A historical destination edit must not display the old yard's ROP.");
const historicalMovedEvidence = proposalContext.smartProposalDecisionEvidence(historicalMovedLine);
assert.match(historicalMovedEvidence, /Destination changed · rebuild plan for yard policy evidence/);
assert.doesNotMatch(historicalMovedEvidence, /Safety stock:/, "A historical destination edit must hide the old yard's policy evidence.");
assert.doesNotMatch(proposalContext.smartProposalDecisionEvidence(bh80Line), /local_item_blend/, "Inactive coverage metadata must not appear as a cause.");
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Safety stock: 3\.002 PLT/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Vendor supply: available/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Imported vendor available: 243 PLT/);
const lowerStockEvidence = proposalContext.smartProposalDecisionEvidence({
  ...bh80Line,
  reason: {
    ...bh80Reason,
    lowerStockPolicyEnabled: true,
    lowerStockPolicyApplied: true,
    configuredMinimumSafetyPallets: 3,
    effectiveMinimumSafetyPallets: 1,
    standardSafetyStockPallets: 3,
    safetyStockPallets: 1,
    standardReorderPointPallets: 11,
    reorderPointPallets: 9,
    standardPreferredPallets: 16,
    preferredPallets: 14
  }
});
assert.match(lowerStockEvidence, /Lower stock policy · 1-PLT floor/);
assert.match(lowerStockEvidence, /Safety 3 → 1/);
assert.match(lowerStockEvidence, /ROP 11 → 9/);
assert.match(lowerStockEvidence, /Preferred 16 → 14 PLT/);

const transferLine = {
  id: 71,
  itemId: 2298,
  itemName: "Transfer test",
  itemDescription: "Generated TO line",
  destinationLocationId: 26,
  destinationName: "150",
  toPlt: 6,
  requiredPallets: 3,
  proposedPallets: 1,
  salesQuantity: 6,
  lineWeightLbs: 1000,
  reason: {
    quantityAvailable: 7,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0,
    availablePallets: 1.166667,
    positionPallets: 1.166667,
    reorderPointPallets: 3,
    preferredPallets: 4,
    minimumOrderPallets: 1,
    capacityPallets: 6,
    sourceAvailablePallets: 2.5,
    sourceSafetyStockPallets: 1,
    sourceReorderPointPallets: 1,
    sourcePreferredPallets: 2,
    sourceLowerStockPolicyEnabled: true,
    sourceLowerStockPolicyApplied: true,
    sourceStandardSafetyStockPallets: 2,
    sourceStandardReorderPointPallets: 2,
    sourceStandardPreferredPallets: 3,
    sourceProtectedFloorPallets: 1,
    sourceMaximumTransferablePallets: 1
  }
};
const transferProposal = {
  id: 700,
  proposalType: "TO",
  phase: "internal_transfer",
  sourceName: "12441",
  destinationLocationId: 26,
  destinationName: "150",
  status: "draft",
  totalPallets: 1,
  totalWeightLbs: 1000,
  utilization: 0.1,
  routeStops: [{ locationId: 26, name: "150" }],
  lines: [transferLine]
};
const transferHtml = proposalContext.smartProposalInventory(transferProposal, transferLine);
assert.match(transferHtml, /12441 source protection/);
assert.match(transferHtml, /Lower stock policy · 1-PLT floor: Safety 2 → 1 PLT · ROP 2 → 1 PLT · Preferred 3 → 2 PLT/);
assert.match(transferHtml, /Protected floor = max\(1 safety stock, 1 ROP\) = 1 PLT/);
assert.match(transferHtml, /Maximum transferable = floor\(max\(0, 2\.5 available − 1 protected\)\) = 1 PLT/);
assert.match(transferHtml, /1 PLT transfer ≤ 1 PLT calculated limit → <strong>within source limit<\/strong>/);
assert.match(transferHtml, /Source after this TO line: <strong>1\.5 PLT<\/strong>/);
assert.match(transferHtml, /150 destination need/);
assert.match(transferHtml, /1\.17 &lt; ROP 3 → target gap 2\.83 PLT → <strong>3 PLT destination policy need<\/strong>/);
assert.match(transferHtml, /Saved rule: min\(ceil\(max\(2\.83 target gap, 1 minimum order\)\), floor\(6 capacity − 1\.17 position\)\) = 3 PLT/);
assert.match(transferHtml, /This TO line carries: <strong>1 of 3 PLT calculated policy need<\/strong>/);
assert.match(transferHtml, /After current 1-PLT TO line: <strong>2\.17 PLT<\/strong>/);
assert.match(proposalContext.smartProposalDecisionEvidence(transferLine), /Source protected floor: 1 PLT/);
assert.match(proposalContext.smartProposalDecisionEvidence(transferLine), /Source transfer limit: 1 PLT/);
const transferAvailabilityHtml = proposalContext.smartProposalAvailability(transferProposal, transferLine);
assert.match(transferAvailabilityHtml, /<small>12441 source available<\/small><strong>2\.5 PLT<\/strong>/);
assert.match(transferAvailabilityHtml, /<small>150 destination available<\/small><strong>1\.17 PLT<\/strong>/);
assert.doesNotMatch(
  transferAvailabilityHtml,
  /smart-availability-hub-tag/,
  "An ordinary internal transfer from 12441 must not be mislabeled as a vendor-hub receipt."
);
assert.doesNotMatch(
  transferAvailabilityHtml,
  /safety|reorder|protected/i,
  "The quick availability column must not repeat the detailed inventory calculation."
);

const manualTransferHtml = proposalContext.smartProposalInventory(transferProposal, {
  ...transferLine,
  requiredPallets: 2,
  proposedPallets: 2,
  reason: {
    quantityAvailable: 12,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0,
    destinationAvailablePallets: 2,
    sourceAvailablePallets: 5,
    manuallyAdded: true
  }
});
assert.match(manualTransferHtml, /Source safety\/ROP calculation was not captured for this manual or legacy line/);
assert.match(manualTransferHtml, /User-entered quantity overrides the safety stock \/ ROP floor/);
assert.match(manualTransferHtml, /2 PLT user-entered transfer ≤ 5 PLT actual available limit → <strong>within source limit<\/strong>/);
assert.match(manualTransferHtml, /Policy trigger and target were not captured for this manual or legacy line/);
assert.match(manualTransferHtml, /Source after this TO line: <strong>3 PLT<\/strong>/);

const groupedTransferHtml = proposalContext.smartProposalInventory({ ...transferProposal, manuallyGrouped: true }, {
  ...transferLine,
  requiredPallets: 6,
  proposedPallets: 2
});
assert.match(groupedTransferHtml, /Stored line requirement 6 PLT differs after editing\/grouping; calculated snapshot need is 3 PLT/);
assert.match(groupedTransferHtml, /This TO line carries: <strong>2 of 3 PLT calculated policy need<\/strong>/);
assert.doesNotMatch(groupedTransferHtml, /6 PLT saved need/);

const inconsistentSourceHtml = proposalContext.smartProposalInventory(transferProposal, {
  ...transferLine,
  reason: {
    ...transferLine.reason,
    sourceAvailablePallets: 5,
    sourceSafetyStockPallets: 1,
    sourceReorderPointPallets: 2,
    sourceProtectedFloorPallets: 1,
    sourceMaximumTransferablePallets: 10
  }
});
assert.match(inconsistentSourceHtml, /Protected floor = max\(1 safety stock, 2 ROP\) = 2 PLT/);
assert.match(inconsistentSourceHtml, /Maximum transferable = floor\(max\(0, 5 available − 2 protected\)\) = 3 PLT/);
assert.match(inconsistentSourceHtml, /Saved source-limit fields are inconsistent; refresh and replan before confirmation/);
assert.match(inconsistentSourceHtml, /1 PLT transfer ≤ 3 PLT calculated limit/);

assert.equal(proposalContext.smartState.planShowInventory, true, "Inventory should be visible by default.");
assert.equal(proposalContext.smartState.planShowDecisionEvidence, true, "Decision evidence should be visible by default.");
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-proposal-view="compact"/);
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-proposal-view="detailed"/);
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-plan-detail="inventory"[^>]*\bchecked\b/);
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-plan-detail="decision-evidence"[^>]*\bchecked\b/);
proposalContext.smartState.planCompact = true;
const compactTransferCard = proposalContext.smartProposalCard({
  ...transferProposal,
  urgencyLevel: "ultimate_urgent",
  urgencyScore: 98,
  lines: [{ ...transferLine, urgencyLevel: "ultimate_urgent", urgencyScore: 98 }]
});
proposalContext.smartPill = (_status, label) => label || "";
const overCapacityTransferCard = proposalContext.smartProposalCard({
  ...transferProposal,
  utilization: 1.08
});
assert.match(overCapacityTransferCard, /Over capacity · manual/,
  "A manually overloaded TO must be clearly flagged instead of appearing capacity-safe.");
proposalContext.smartPill = () => "";
assert.match(compactTransferCard, /smart-proposal-lines smart-table-wrap smart-proposal-lines-compact/);
assert.match(compactTransferCard, /<th data-smart-plan-column="availability">Availability<\/th>/);
assert.match(compactTransferCard, /<td data-smart-plan-column="availability"><div class="smart-availability-summary smart-availability-inline">/);
assert.match(compactTransferCard, /class="smart-urgency-ultimate_urgent"/);
assert.match(compactTransferCard, /Ultimate Urgent urgency\.<\/span>/);
assert.match(compactTransferCard, /class="smart-proposal-identity"/);
assert.match(compactTransferCard, /class="smart-proposal-badges"/);
assert.match(compactTransferCard, /class="smart-proposal-line-editor-controls"/);
assert.match(compactTransferCard, /data-smart-line-results="700" aria-live="polite"><\/div>/);
assert.doesNotMatch(compactTransferCard, /ID 2298/, "Compact material rows must omit the item ID.");
assert.doesNotMatch(compactTransferCard, /Generated TO line/, "Compact material rows must omit the description.");
assert.doesNotMatch(
  compactTransferCard,
  /data-smart-plan-column="availability" hidden/,
  "Quick availability must remain visible when both detailed columns are hidden."
);
assert.match(compactTransferCard, /data-smart-plan-column="inventory" hidden/);
assert.match(compactTransferCard, /data-smart-plan-column="decision-evidence" hidden/);
const physicalPalletRowHtml = proposalContext.smartPhysicalPalletLineRow(transferProposal, {
  id: "physical-26",
  itemId: 4530789,
  itemName: "PALLET",
  destinationLocationId: 26,
  destinationName: "150",
  quantity: 1,
  automaticQuantity: 1,
  unit: "EACH",
  itemWeightLbs: 40,
  lineWeightLbs: 40
}, false);
assert.equal(
  (physicalPalletRowHtml.match(/<td\b/g) || []).length,
  9,
  "Physical PALLET rows must stay aligned with the nine proposal-table columns."
);
assert.match(
  physicalPalletRowHtml,
  /<td data-smart-plan-column="availability"><span class="smart-help">Ancillary packaging item<\/span><\/td>/,
  "Physical PALLET rows need an explicit non-inventory availability cell."
);
proposalContext.smartState.planCompact = false;
proposalContext.smartState.planShowInventory = true;
proposalContext.smartState.planShowDecisionEvidence = false;
const oneDetailHiddenCard = proposalContext.smartProposalCard(transferProposal);
assert.match(oneDetailHiddenCard, /smart-proposal-lines smart-table-wrap smart-proposal-lines-one-detail-hidden/);
assert.doesNotMatch(oneDetailHiddenCard, /data-smart-plan-column="inventory" hidden/);
assert.match(oneDetailHiddenCard, /data-smart-plan-column="decision-evidence" hidden/);
proposalContext.smartState.planShowDecisionEvidence = true;
proposalContext.localStorage = { setItem() { throw new Error("quota exceeded"); } };
assert.equal(proposalContext.smartSaveProposalColumnPreferences(), false, "Storage quota failures must not block column changes.");
proposalContext.localStorage = { getItem() { throw new Error("storage unavailable"); } };
const fallbackColumns = proposalContext.smartLoadProposalColumnPreferences();
assert.equal(fallbackColumns.compact, true);
assert.equal(fallbackColumns.inventory, true);
assert.equal(fallbackColumns.decisionEvidence, true);
delete proposalContext.localStorage;

assert.equal(
  proposalContext.smartUrgencyLevel("normal", true),
  "urgent",
  "A legacy urgent flag must not be erased by a default normal level."
);
assert.equal(proposalContext.smartProposalUrgencyScore({
  lines: [
    { urgencyLevel: "ultimate_urgent", urgencyScore: 61 },
    { urgencyLevel: "urgent", urgencyScore: 99 }
  ]
}), 61, "Proposal score fallback must use only lines at the proposal's highest tier.");
const stockoutEvidenceHtml = proposalContext.smartProposalDecisionEvidence({
  ...transferLine,
  urgencyLevel: "super_urgent",
  urgencyScore: 76,
  reason: {
    ...transferLine.reason,
    stockoutDemandMethod: "mixed",
    stockoutDemandConfidence: "low",
    stockoutSnapshotWeeks: 2,
    stockoutProxyWeeks: 4,
    stockoutEvidenceStartWeek: "2026-05-04",
    stockoutEvidenceEndWeek: "2026-07-20",
    demandDataCutoff: "2026-07-27"
  }
});
assert.match(stockoutEvidenceHtml, /Stockout demand: snapshots \+ positive-sales proxy · low confidence · 6 eligible weeks · 2 snapshot · 4 proxy · 2026-05-04 to 2026-07-20 · sales cutoff 2026-07-27/);
assert.match(stockoutEvidenceHtml, /Urgency: Super Urgent · score 76/);

proposalContext.smartState.plan = {
  proposals: [
    { ...transferProposal, id: 10, proposalType: "PO", vendor: "  Vendor   A ", urgencyLevel: "urgent", urgencyScore: 35 },
    { ...transferProposal, id: 11, proposalType: "PO", vendor: "Vendor A", urgencyLevel: "ultimate_urgent", urgencyScore: 92 },
    { ...transferProposal, id: 12, proposalType: "PO", vendor: "Vendor B", urgencyLevel: "super_urgent", urgencyScore: 70 },
    { ...transferProposal, id: 13, proposalType: "TO", vendor: "", sourceName: "2967", urgencyLevel: "urgent", urgencyScore: 40 }
  ]
};
proposalContext.smartState.planType = "";
proposalContext.smartState.planVendor = "vendor a";
proposalContext.smartState.planShowInventory = true;
proposalContext.smartState.planShowDecisionEvidence = true;
assert.deepEqual(
  [...proposalContext.smartFilteredProposals()].map((proposal) => proposal.id),
  [11, 10],
  "The combined-view vendor filter must retain matching POs, reject TOs, normalize vendor names, and sort higher urgency first."
);
const poPlansHtml = proposalContext.smartPlans();
assert.match(poPlansHtml, /<select id="smartPlanVendor" aria-label="PO vendor" >/);
assert.equal((poPlansHtml.match(/value="vendor a"/g) || []).length, 1, "Duplicate vendor spellings must produce one filter option.");
assert.match(poPlansHtml, /value="vendor a" selected>Vendor A<\/option>/);
assert.doesNotMatch(poPlansHtml, /id="smartPlanVendor"[^>]*hidden disabled/, "The vendor filter must be visible in PO + TO view.");
proposalContext.smartState.planType = "PO";
assert.deepEqual([...proposalContext.smartFilteredProposals()].map((proposal) => proposal.id), [11, 10]);
proposalContext.smartState.planType = "TO";
proposalContext.smartState.planVendor = "";
assert.deepEqual([...proposalContext.smartFilteredProposals()].map((proposal) => proposal.id), [13]);
assert.match(proposalContext.smartPlans(), /id="smartPlanVendor"[^>]*hidden disabled/);

proposalContext.smartState.planType = "";
proposalContext.smartState.planVendor = "";
proposalContext.smartState.data.planningExclusions = {
  items: [{
    id: 81,
    itemId: 24023,
    itemName: "TH-COV60T-3045-BEI",
    vendor: "Vendor A",
    reason: "Vendor out of stock",
    expiresAt: null,
    createdAt: "2026-08-01T12:00:00Z",
    active: true
  }],
  activeCount: 1,
  blanketItems: [{
    itemId: 24024,
    itemName: "BLANKET-COVERED-SKU",
    vendor: "Vendor B",
    availablePallets: 12,
    availableSalesQty: 1200,
    sourcePoRefs: ["PO-BLANKET-81"],
    active: true,
    automatic: true,
    pauseKind: "blanket_po"
  }],
  blanketCount: 1,
  combinedActiveCount: 2
};
vm.runInContext("smartPlanningExclusionState.open = true", proposalContext);
const exclusionPlansHtml = proposalContext.smartPlans();
assert.match(exclusionPlansHtml, /Paused items \(2\)/);
assert.match(exclusionPlansHtml, /TH-COV60T-3045-BEI/);
assert.match(exclusionPlansHtml, /Vendor out of stock/);
assert.match(exclusionPlansHtml, /Automatic — Blanket balance/);
assert.match(exclusionPlansHtml, /BLANKET-COVERED-SKU/);
assert.match(exclusionPlansHtml, /Blanket PO covered · 12 PLT remaining/);
assert.match(exclusionPlansHtml, /Source PO-BLANKET-81/);
assert.match(exclusionPlansHtml, /TO remains available/);
assert.match(exclusionPlansHtml, /Manual pauses exclude an item only from new vendor PO planning/i);
assert.match(exclusionPlansHtml, /Generated and manually added TO loads remain available/i);
const exclusionUiSource = readPublic("scm-smart-exclusions.js");
const addExclusionBranch = exclusionUiSource.slice(
  exclusionUiSource.indexOf('action === "add-planning-exclusion"'),
  exclusionUiSource.indexOf('action === "remove-planning-exclusion"')
);
assert.doesNotMatch(addExclusionBranch, /smartPlanningExclusionState\.search\s*=\s*""/,
  "Pausing one SKU must retain the current item search.");
assert.doesNotMatch(addExclusionBranch, /smartPlanningExclusionState\.candidates\s*=\s*\[\]/,
  "Pausing one SKU must retain the current result list for multi-SKU pausing.");
assert.doesNotMatch(addExclusionBranch, /smartPlanningExclusionState\.expiresAt\s*=\s*""/,
  "Pausing one SKU must retain the shared reason and expiry for the remaining results.");
assert.match(exclusionUiSource, /excluded \? "Already paused for PO" : blanketCovered \? "Add manual PO pause" : "Pause vendor PO"/,
  "The retained list must mark each newly PO-paused SKU without removing the other results.");

const priorityProposal = (id, urgencyLevel, urgencyScore, yard, sourceName = "Vendor") => ({
  ...transferProposal,
  id,
  sourceName,
  destinationName: yard,
  urgencyLevel,
  urgencyScore,
  routeStops: [{ locationId: id + 100, name: yard }],
  lines: [{ ...transferLine, destinationName: yard, urgencyLevel, urgencyScore }]
});
proposalContext.smartState.plan = {
  proposals: [
    priorityProposal(201, "normal", 99, "3445"),
    priorityProposal(202, "urgent", 99, "150"),
    priorityProposal(203, "urgent", 1, "3445"),
    priorityProposal(204, "ultimate_urgent", 1, "150"),
    priorityProposal(205, "super_urgent", 1, "2967"),
    priorityProposal(206, "urgent", 50, "12441"),
    priorityProposal(207, "urgent", 50, "2967"),
    priorityProposal(208, "normal", 1, "12441")
  ]
};
proposalContext.smartState.planType = "";
proposalContext.smartState.planVendor = "";
proposalContext.smartState.planSource = "";
proposalContext.smartState.planDestination = "";
proposalContext.smartState.planSort = "source";
assert.deepEqual(
  [...proposalContext.smartFilteredProposals()].map((proposal) => proposal.id),
  [204, 205, 203, 206, 207, 202, 201, 208],
  "Loads must sort by urgency tier, then 3445, 12441, 2967, and 150 before score or route tie-breakers."
);
assert.equal(
  proposalContext.smartProposalDestinationPriority({
    ...transferProposal,
    routeStops: [{ name: "150" }, { name: "12441 delivery yard" }]
  }),
  1,
  "A multi-stop load must use its highest-priority destination yard."
);

const proposalCss = readPublic("scm-smart-proposals.css");
assert.match(proposalCss, /\.smart-proposal-lines \.smart-table\s*\{\s*min-width: 1420px;/);
assert.match(proposalCss, /\.smart-proposal-lines-one-detail-hidden \.smart-table\s*\{\s*min-width: 1210px;/);
assert.match(proposalCss, /\.smart-proposal-lines-compact \.smart-table\s*\{\s*min-width: 1060px;/);
assert.match(proposalCss, /\.smart-proposal-lines-compact \.smart-table td \{\s*padding-top: 5px;/);
assert.match(
  proposalCss,
  /\.smart-proposal-head\s*\{[\s\S]*?grid-template-columns:\s*max-content minmax\(170px, 1fr\) repeat\(3, max-content\) max-content;[\s\S]*?padding:\s*6px 10px;/,
  "Proposal headers must remain one compact desktop row."
);
assert.match(
  proposalCss,
  /\.smart-proposal-line-editor-controls\s*\{[\s\S]*?grid-template-columns:\s*max-content minmax\(135px, 190px\) minmax\(240px, 1fr\);/,
  "Add-line controls must remain one compact desktop row."
);
assert.match(proposalCss, /\.smart-proposal-item-results:empty\s*\{\s*display:\s*none;/);
assert.match(proposalCss, /\.smart-table tr\.smart-urgency-ultimate_urgent/);
assert.match(proposalCss, /\.smart-availability-inline\s*\{[\s\S]*?display: flex;[\s\S]*?white-space: nowrap;/);
assert.match(
  proposalCss,
  /\.smart-plan-sticky\s*\{[\s\S]*?top:\s*calc\(var\(--smart-topbar-height\) \+ var\(--smart-tabs-height\)\);[\s\S]*?z-index:\s*20;/,
  "The proposal controls must stick below the application tabs."
);

const appListeners = new Map();
const appMount = {
  focusedControl: null,
  addEventListener(type, listener) {
    appListeners.set(type, listener);
  },
  contains(element) {
    return element?._insideSmartScm === true;
  },
  querySelector() {
    return this.focusedControl;
  },
  querySelectorAll() {
    return this.focusedControl ? [this.focusedControl] : [];
  },
  innerHTML: ""
};
const focusDocument = {
  activeElement: null,
  getElementById: () => appMount,
  addEventListener() {},
  createElement: () => ({ click() {}, remove() {} }),
  body: { appendChild() {} }
};
const focusComputedStyle = (element) => ({
  display: element?.hidden || element?._ancestorHidden ? "none" : "block",
  visibility: element?.hidden || element?._ancestorHidden ? "hidden" : "visible"
});
const forecastContext = vm.createContext({
  document: focusDocument,
  window: { addEventListener() {}, getComputedStyle: focusComputedStyle },
  getComputedStyle: focusComputedStyle,
  CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`) },
  requireDispatchLogin() {},
  dispatchLogout() {},
  fetch: async () => { throw new Error("Unexpected fetch in UI harness."); },
  smartNumber,
  Intl,
  URL,
  URLSearchParams,
  Blob,
  ArrayBuffer,
  FormData,
  Map,
  Set,
  setTimeout,
  clearTimeout
});
const smartCoreUiSource = readPublic("scm-smart.js");
const smartBlanketUiSource = readPublic("scm-smart-blanket.js");
const smartVendorUiSource = readPublic("scm-smart-vendor.js");
vm.runInContext(smartCoreUiSource, forecastContext, { filename: "scm-smart.js" });
vm.runInContext("smartState.operator = { role: 'scm' };", forecastContext);

const smartNoticeDismissSource = smartCoreUiSource.slice(
  smartCoreUiSource.indexOf("function smartScheduleNoticeDismissal()"),
  smartCoreUiSource.indexOf("function smartRender()")
);
assert.doesNotMatch(
  smartNoticeDismissSource,
  /\bsmartRender\s*\(/,
  "Automatic notice dismissal must not redraw the whole Smart SCM workspace and interrupt an active editor."
);
const smartRenderSource = smartCoreUiSource.slice(
  smartCoreUiSource.indexOf("function smartRender()"),
  smartCoreUiSource.indexOf("async function smartWork")
);
const smartCaptureIndex = smartRenderSource.indexOf("smartCaptureFocusedControl(");
const smartInnerHtmlIndex = smartRenderSource.indexOf("smartScmApp.innerHTML");
const smartRestoreIndex = smartRenderSource.indexOf("smartRestoreFocusedControl(");
assert.ok(
  smartCaptureIndex >= 0 && smartCaptureIndex < smartInnerHtmlIndex
    && smartInnerHtmlIndex < smartRestoreIndex,
  "smartRender must capture the active control before replacing innerHTML and restore it afterward."
);
assert.doesNotMatch(
  smartBlanketUiSource,
  /setSelectionRange\s*\(\s*input\.value\.length\s*,\s*input\.value\.length\s*\)/,
  "Blanket search must rely on the shared exact-caret restoration instead of forcing the caret to the end."
);
assert.doesNotMatch(
  smartVendorUiSource,
  /setSelectionRange\s*\(\s*input\.value\.length\s*,\s*input\.value\.length\s*\)/,
  "Vendor Replies search must rely on the shared exact-caret restoration instead of forcing the caret to the end."
);
assert.match(
  smartCoreUiSource,
  /addEventListener\("compositionstart"[\s\S]*?smartCompositionDepth \+= 1/,
  "Smart SCM must defer destructive redraws while an IME composition is active."
);
assert.match(
  smartCoreUiSource,
  /addEventListener\("compositionend"[\s\S]*?smartScheduleItemSearchRefresh\(\)[\s\S]*?smartRender\(\)/,
  "Ending an IME composition must resume Item Master search and any deferred redraw."
);

function focusHarnessControl({
  id = "smartFocusHarness",
  inside = true,
  disabled = false,
  hidden = false,
  ancestorHidden = false,
  selectionStart = 2,
  selectionEnd = 5,
  throwOnSelection = false
} = {}) {
  const attributes = new Map([["id", id], ["type", "search"]]);
  return {
    id,
    type: "search",
    tagName: "INPUT",
    dataset: {},
    parentElement: null,
    isConnected: true,
    _insideSmartScm: inside,
    _ancestorHidden: ancestorHidden,
    disabled,
    hidden,
    selectionStart,
    selectionEnd,
    offsetParent: hidden || ancestorHidden ? null : {},
    focusCount: 0,
    hasAttribute(name) { return attributes.has(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    matches(selector) {
      if (selector.includes(":disabled") && this.disabled) return true;
      if (selector.includes("[hidden]") && this.hidden) return true;
      return /input|select|textarea|button|contenteditable/i.test(selector);
    },
    closest(selector) {
      if (this._ancestorHidden && /hidden|aria-hidden/.test(selector)) return { hidden: true };
      return null;
    },
    checkVisibility() { return !this.hidden && !this._ancestorHidden; },
    getClientRects() { return this.hidden || this._ancestorHidden ? [] : [{}]; },
    focus(options) {
      this.focusCount += 1;
      this.focusOptions = options;
    },
    setSelectionRange(start, end) {
      if (throwOnSelection) throw new Error("Selection is unavailable for this input type.");
      this.restoredSelection = { start, end };
    }
  };
}

const originalFocusedControl = focusHarnessControl({ selectionStart: 3, selectionEnd: 7 });
focusDocument.activeElement = originalFocusedControl;
appMount.focusedControl = originalFocusedControl;
const focusedControlSnapshot = forecastContext.smartCaptureFocusedControl();
const replacementFocusedControl = focusHarnessControl({ selectionStart: 0, selectionEnd: 0 });
appMount.focusedControl = replacementFocusedControl;
forecastContext.smartRestoreFocusedControl(focusedControlSnapshot);
assert.equal(replacementFocusedControl.focusCount, 1, "A surviving active input must regain focus after a shared redraw.");
assert.equal(replacementFocusedControl.focusOptions?.preventScroll, true, "Focus restoration must not jump the workspace scroll position.");
assert.deepEqual(
  replacementFocusedControl.restoredSelection,
  { start: 3, end: 7 },
  "Focus restoration must preserve the exact caret or selected text range."
);

focusDocument.activeElement = focusHarnessControl({ inside: false });
appMount.focusedControl = focusDocument.activeElement;
assert.ok(
  forecastContext.smartCaptureFocusedControl() == null,
  "An editor outside Smart SCM must never be captured or receive stolen focus."
);

focusDocument.activeElement = originalFocusedControl;
appMount.focusedControl = originalFocusedControl;
const missingControlSnapshot = forecastContext.smartCaptureFocusedControl();
appMount.focusedControl = null;
assert.doesNotThrow(() => forecastContext.smartRestoreFocusedControl(missingControlSnapshot));

for (const replacement of [
  focusHarnessControl({ disabled: true }),
  focusHarnessControl({ hidden: true }),
  focusHarnessControl({ ancestorHidden: true })
]) {
  appMount.focusedControl = replacement;
  assert.doesNotThrow(() => forecastContext.smartRestoreFocusedControl(missingControlSnapshot));
  assert.equal(replacement.focusCount, 0, "Removed, disabled, or hidden controls must not regain focus after a redraw.");
}

const throwingSelectionControl = focusHarnessControl({ throwOnSelection: true });
appMount.focusedControl = throwingSelectionControl;
assert.doesNotThrow(
  () => forecastContext.smartRestoreFocusedControl(missingControlSnapshot),
  "A control-specific selection API failure must not break the shared Smart SCM render."
);
assert.equal(throwingSelectionControl.focusCount, 1, "Selection failure must not undo successful focus restoration.");

forecastContext.__itemResponses = [];
vm.runInContext(`
  smartState.itemSearch = "first";
  smartState.itemData = null;
  smartRender = () => {};
  smartApi = () => new Promise((resolve) => __itemResponses.push(resolve));
`, forecastContext);
const firstItemLoad = vm.runInContext("smartLoadItems({ quiet: true })", forecastContext);
vm.runInContext('smartState.itemSearch = "second"', forecastContext);
const secondItemLoad = vm.runInContext("smartLoadItems({ quiet: true })", forecastContext);
forecastContext.__itemResponses[1]({ marker: "newest", items: [] });
await secondItemLoad;
forecastContext.__itemResponses[0]({ marker: "stale", items: [] });
await firstItemLoad;
assert.equal(
  vm.runInContext("smartState.itemData.marker", forecastContext),
  "newest",
  "An older Item Master response must never replace results for a newer search."
);
const floatingNoticesHtml = vm.runInContext(`
  smartState.error = "Failed <unsafe>";
  smartState.notice = "Saved";
  smartState.busy = "Refreshing";
  smartFloatingNotices();
`, forecastContext);
assert.match(floatingNoticesHtml, /^<div class="smart-floating-notices" aria-live="polite" aria-atomic="true">/);
assert.match(floatingNoticesHtml, /<div class="smart-notice error smart-dismissible-notice" role="alert"><span>Failed &lt;unsafe&gt;<\/span>/);
assert.match(floatingNoticesHtml, /<div class="smart-notice smart-dismissible-notice"><span>Saved<\/span>/);
assert.match(floatingNoticesHtml, /data-smart-action="dismiss-smart-notice"/);
assert.match(floatingNoticesHtml, /<div class="smart-notice">Refreshing…<\/div>/);
assert.equal(vm.runInContext(`
  smartState.error = "";
  smartState.notice = "";
  smartState.busy = "";
  smartFloatingNotices();
`, forecastContext), "", "The floating notice layer must not render when there is no message.");
const smartCss = readPublic("scm-smart.css");
assert.match(
  smartCss,
  /\.smart-floating-notices\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*72px;[\s\S]*?z-index:\s*80;/,
  "Top-level Smart SCM notices must remain fixed above the sticky header and plan controls."
);
assert.match(
  smartCss,
  /\.smart-tabs\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*var\(--smart-topbar-height\);[\s\S]*?overflow-x:\s*auto;/,
  "Smart SCM tabs must remain sticky and horizontally scrollable."
);
assert.match(
  smartCss,
  /@media \(max-width: 1500px\)\s*\{[\s\S]*?--smart-topbar-height:\s*96px;/,
  "Sticky offsets must follow the two-row Smart SCM topbar at common viewport widths."
);
assert.match(readPublic("scm-smart.js"), /<span>Stockout average period<\/span>[\s\S]*?positive-sales proxy weeks averaged/);
forecastContext.__capturedItemsUrl = null;
vm.runInContext(`
  smartState.itemLowerStockPolicy = "yard:150";
  smartApi = async (url) => {
    __capturedItemsUrl = url;
    return { items: [], total: 0, limit: 150, offset: 0, vendorYards: [] };
  };
  smartRender = () => {};
`, forecastContext);
await vm.runInContext("smartLoadItems({ reset: true, quiet: true })", forecastContext);
const filteredItemsUrl = new URL(forecastContext.__capturedItemsUrl, "https://example.test");
assert.equal(filteredItemsUrl.searchParams.get("lowerStockPolicy"), "yard:150");
const lowerStockFilterOptions = vm.runInContext("smartLowerStockPolicyFilterOptions()", forecastContext);
assert.match(lowerStockFilterOptions, /value="yard:150" selected>Lower stock enabled · 150<\/option>/);
assert.match(lowerStockFilterOptions, /value="any" >Lower stock enabled · any yard<\/option>/);

const itemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: false,
    capacityPallets: null,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
const itemYardLowerPolicyInput = itemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "";
assert.match(itemYardLowerPolicyInput, /type="checkbox"/);
assert.match(itemYardLowerPolicyInput, /\bchecked\b/, "The optional policy must render its saved per-yard state.");
assert.match(itemYardLowerPolicyInput, /aria-label="Lower stock policy for LOWER-STOCK-TEST, yard 2967"/);
assert.match(
  itemYardLowerPolicyInput,
  /\bdisabled\b/,
  "The lower-stock policy must remain visible but disabled while this yard is not planned."
);
const plannedItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
const plannedItemYardLowerPolicyInput = plannedItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "";
assert.match(plannedItemYardLowerPolicyInput, /\bchecked\b/);
assert.doesNotMatch(plannedItemYardLowerPolicyInput, /\bdisabled\b/, "A write user must be able to select the optional policy for a planned yard.");
const defaultOffItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "DEFAULT-OFF-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: false
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
assert.doesNotMatch(
  defaultOffItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "",
  /\bchecked\b/,
  "The optional policy must render unchecked when it has not been enabled."
);
assert.match(defaultOffItemYardHtml, /Lower stock policy \(1-PLT floor\)/, "Touch layouts need a visible policy explanation.");
vm.runInContext("smartState.operator = { role: 'yard_manager' };", forecastContext);
const readOnlyItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
assert.match(
  readOnlyItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "",
  /\bdisabled\b/,
  "Read-only roles must not be able to change the lower-stock policy."
);
vm.runInContext("smartState.operator = { role: 'scm' };", forecastContext);

forecastContext.__capturedItemSave = null;
vm.runInContext(`
  smartApi = async (url, options = {}) => {
    __capturedItemSave = { url, body: options.body };
    return { itemId: 501 };
  };
  smartRender = () => {};
  smartRestoreItemViewport = () => {};
`, forecastContext);
const itemSaveClick = appListeners.get("click");
assert.equal(typeof itemSaveClick, "function");
const capacityInput = {
  value: "12",
  dataset: {},
  setCustomValidity(message) { this.validationMessage = message; },
  focus() { this.focused = true; },
  reportValidity() { this.reported = true; }
};
const lowerStockPolicyInput = { checked: true, disabled: false };
const yardToggle = {
  checked: true,
  dataset: {
    itemYardEnabled: "28",
    yardCode: "2967",
    serviceQuantile: "0.9"
  },
  matches(selector) {
    return selector === "[data-item-yard-enabled]";
  },
  closest(selector) {
    return selector === "[data-item-row]" ? itemRow : null;
  }
};
const vendorYardSelect = { value: "", dataset: { sourceYard: "" } };
const itemRow = {
  dataset: { itemRow: "501" },
  closest(selector) {
    return selector === ".smart-item-grid-wrap"
      ? { scrollLeft: 0, scrollTop: 0 }
      : null;
  },
  getBoundingClientRect() {
    return { top: 100 };
  },
  querySelectorAll(selector) {
    return selector === "[data-item-yard-enabled]" ? [yardToggle] : [];
  },
  querySelector(selector) {
    const fields = {
      '[data-item-yard-capacity="28"]': capacityInput,
      '[data-item-yard-lower-stock="28"]': lowerStockPolicyInput,
      '[data-item-field="vendorYardId"]': vendorYardSelect,
      '[data-item-field="planningEnabled"]': { checked: true },
      '[data-item-field="leadTimeDays"]': { value: "14" }
    };
    return fields[selector] || null;
  }
};
const itemYardChange = appListeners.get("change");
assert.equal(typeof itemYardChange, "function");
yardToggle.checked = false;
await itemYardChange({ target: yardToggle });
assert.equal(lowerStockPolicyInput.checked, true, "Disabling yard planning must preserve the optional policy selection.");
assert.equal(lowerStockPolicyInput.disabled, true);
assert.equal(capacityInput.value, "");
yardToggle.checked = true;
await itemYardChange({ target: yardToggle });
assert.equal(lowerStockPolicyInput.checked, true, "Re-enabling yard planning must retain the policy selection.");
assert.equal(lowerStockPolicyInput.disabled, false);
assert.equal(capacityInput.value, "12", "Capacity's existing off/on restoration must remain intact.");

const saveButton = {
  dataset: { smartAction: "save-item", itemId: "501" },
  disabled: false,
  textContent: "Save",
  closest(selector) {
    if (selector === "[data-smart-action]") return this;
    if (selector === "[data-item-row]") return itemRow;
    return null;
  }
};
await itemSaveClick({
  target: {
    closest(selector) {
      if (selector === "[data-smart-tab]") return null;
      if (selector === "[data-smart-action]") return saveButton;
      return null;
    }
  }
});
assert.equal(forecastContext.__capturedItemSave.url, "/api/scm/smart/items/501");
assert.equal(forecastContext.__capturedItemSave.body.yardPolicies[0].lowerStockPolicyEnabled, true);
assert.equal(
  Object.hasOwn(forecastContext.__capturedItemSave.body.yardPolicies[0], "minimumSafetyPallets"),
  false,
  "The checkbox save must leave the legacy configured floor untouched."
);
assert.equal(forecastContext.__capturedItemSave.body.yardPolicies[0].locationId, 28);

const forecastPolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  safetyStockPallets: 3.002221,
  baseReorderPointPallets: 11,
  basePreferredPallets: 16,
  reorderPointPallets: 11,
  preferredPallets: 16,
  weeklyDemandPallets: 4,
  weeklyDemandSdPallets: 1.632993,
  leadWeeks: 2,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 16,
  zeroDemandCoverageApplied: false
})`, forecastContext);
assert.match(forecastPolicyHtml, /Safety stock <strong>3\.002 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /ROP <strong>11 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /Preferred stock level <strong>16 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /Capacity <strong>16 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /4 PLT\/week · SD 1\.633 · 2 lead weeks · factor 1\.3 · current policy\/settings/);
assert.match(forecastPolicyHtml, /ROP = round\(3\.002 safety \+ 4 demand × 2 lead\) = 11 PLT/);
assert.match(forecastPolicyHtml, /Preferred = min\(16 capacity, ceil\(11 ROP \+ 4 demand × 2 lead\)\) = 16 PLT/);

const stockoutForecastEvidence = vm.runInContext(`smartForecastStockoutEvidence({
  stockoutDemandMethod: "mixed",
  stockoutDemandConfidence: "low",
  stockoutSnapshotWeeks: 2,
  stockoutProxyWeeks: 4,
  stockoutEvidenceStartWeek: "2026-05-04",
  stockoutEvidenceEndWeek: "2026-07-20",
  demandDataCutoff: "2026-07-27"
})`, forecastContext);
assert.match(stockoutForecastEvidence, /snapshots \+ positive-sales proxy · low confidence/);
assert.match(stockoutForecastEvidence, /6 eligible weeks · 2 snapshot · 4 proxy · 2026-05-04 to 2026-07-20 · sales cutoff 2026-07-27/);

const lowerStockPolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  lowerStockPolicyEnabled: true,
  lowerStockPolicyApplied: true,
  standardSafetyStockPallets: 3,
  safetyStockPallets: 1,
  standardReorderPointPallets: 11,
  baseReorderPointPallets: 9,
  standardPreferredPallets: 16,
  basePreferredPallets: 14,
  reorderPointPallets: 9,
  preferredPallets: 14,
  weeklyDemandPallets: 4,
  weeklyDemandSdPallets: 0,
  leadWeeks: 2,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 20,
  zeroDemandCoverageApplied: false
})`, forecastContext);
assert.match(lowerStockPolicyHtml, /Lower stock policy applied · 1-PLT minimum safety floor/);
assert.match(lowerStockPolicyHtml, /Safety 3 → 1 PLT/);
assert.match(lowerStockPolicyHtml, /ROP 11 → 9 PLT/);
assert.match(lowerStockPolicyHtml, /Preferred 16 → 14 PLT/);

const coveragePolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  safetyStockPallets: 2,
  baseReorderPointPallets: 2,
  basePreferredPallets: 2,
  reorderPointPallets: 4,
  preferredPallets: 4,
  weeklyDemandPallets: 0,
  weeklyDemandSdPallets: 0,
  leadWeeks: 1,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 6,
  zeroDemandCoverageApplied: true
})`, forecastContext);
assert.match(coveragePolicyHtml, /coverage floor raises final ROP to 4 PLT/);
assert.match(coveragePolicyHtml, /Preferred = min\(6 capacity, max\(2 base preferred, 4 ROP\)\) = 4 PLT/);

console.log("Smart SCM calculation UI harness passed.");

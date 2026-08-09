import assert from "node:assert/strict";
import {
  consolidateCompatibleDrafts,
  smartScmBuildPlanningDrafts,
  smartScmPackWholePalletLines
} from "./smart-scm-planning-repository.js";

const settings = {
  truck_capacity_lbs: 78000,
  hold_load_ratio: 0.5,
  vendor_response_sla_hours: 24
};

function hubDemandState(requiredPallets) {
  return {
    key: "1354:15",
    requiredPallets,
    toPlt: 125.4,
    safety: 17.042681,
    rop: 32,
    preferred: 25,
    capacity: 25,
    minimumOrder: 6,
    standardSafety: 17.042681,
    standardRop: 32,
    standardPreferred: 25,
    availablePallets: 0,
    positionPallets: 0,
    urgent: true,
    urgencyLevel: "ultimate_urgent",
    urgencyScore: 82.3129,
    manualPlanningRequired: false,
    policy: {
      item_id: 1354,
      item_name: "BWS-TRE50S-RDM-GC",
      item_description: "Trevista 50mm S Rdm Glacier Creek",
      stock_unit: "SQFT",
      to_plt: 125.4,
      to_lyr: 10.45,
      to_sec: 0,
      to_pcs: 0,
      pallet_weight_lbs: 3009.6,
      physical_pallet_weight_lbs: 40,
      vendor_yard_id: 5,
      vendor: "BWS",
      plant: "BWS Uxbridge",
      location_id: 15,
      yard_code: "12441"
    }
  };
}

function planningDrafts({ requiredPallets, supplyStatus, vendorAvailablePallets = 0 }) {
  return smartScmBuildPlanningDrafts({
    states: [hubDemandState(requiredPallets)],
    supplyMap: new Map([["1354", {
      status: supplyStatus,
      available_pallets: vendorAvailablePallets
    }]]),
    settings
  }).drafts;
}

const reproduced = planningDrafts({
  requiredPallets: 25,
  supplyStatus: "unknown"
});
assert.equal(
  reproduced.filter((draft) => draft.phase === "vendor_hub").length,
  0,
  "A 25-PLT shortage at hub yard 12441 must not create a second 25-PLT vendor-hub PO beside the direct PO."
);
assert.equal(
  reproduced
    .filter((draft) => draft.proposalType === "PO")
    .flatMap((draft) => draft.lines)
    .reduce((sum, line) => sum + line.proposedPallets, 0),
  25,
  "One 25-PLT shortage at yard 12441 must create at most 25 PLT of actionable PO quantity."
);

const remoteState = hubDemandState(6);
remoteState.key = "1354:1";
remoteState.policy = {
  ...remoteState.policy,
  location_id: 1,
  yard_code: "3445"
};
const remoteDrafts = smartScmBuildPlanningDrafts({
  states: [remoteState],
  supplyMap: new Map([["1354", { status: "unknown", available_pallets: 0 }]]),
  settings
}).drafts;
const unexpectedRemoteHubLines = remoteDrafts
  .filter((draft) => draft.phase === "vendor_hub")
  .flatMap((draft) => draft.lines);
assert.equal(
  unexpectedRemoteHubLines.length,
  0,
  "A fully covered non-hub need must not receive an additional vendor-hub PO."
);
assert.equal(
  remoteDrafts.flatMap((draft) => draft.lines)
    .reduce((sum, line) => sum + line.proposedPallets, 0),
  6,
  "A fully covered 6-PLT remote need must conserve exactly 6 PLT across every proposal phase."
);

const partialRemoteDrafts = smartScmBuildPlanningDrafts({
  states: [structuredClone(remoteState)],
  supplyMap: new Map([["1354", { status: "partial", available_pallets: 2 }]]),
  settings
}).drafts;
const legitimateRemoteHubLines = partialRemoteDrafts
  .filter((draft) => draft.phase === "vendor_hub")
  .flatMap((draft) => draft.lines);
assert.equal(
  legitimateRemoteHubLines.reduce((sum, line) => sum + line.proposedPallets, 0),
  4,
  "Only the uncovered 4-PLT residual may become a vendor-hub fallback."
);
assert.ok(
  legitimateRemoteHubLines.every((line) => line.reason.actualDestinationYard === "3445"),
  "A legitimate vendor-hub residual must retain the real destination yard."
);
assert.equal(
  partialRemoteDrafts.flatMap((draft) => draft.lines)
    .reduce((sum, line) => sum + line.proposedPallets, 0),
  6,
  "Two direct pallets plus four hub-routed pallets must conserve the 6-PLT need."
);

const transferDestination = structuredClone(remoteState);
transferDestination.requiredPallets = 10;
const transferSource = hubDemandState(0);
transferSource.availablePallets = 5;
transferSource.safety = 0;
transferSource.rop = 0;
transferSource.preferred = 0;
const residualAllocationDrafts = smartScmBuildPlanningDrafts({
  states: [transferDestination, transferSource],
  supplyMap: new Map([["1354", { status: "partial", available_pallets: 2 }]]),
  settings
}).drafts;
const phasePallets = (phase) => residualAllocationDrafts
  .filter((draft) => draft.phase === phase)
  .flatMap((draft) => draft.lines)
  .reduce((sum, line) => sum + line.proposedPallets, 0);
assert.equal(phasePallets("direct_vendor"), 2);
assert.equal(phasePallets("internal_transfer"), 5);
assert.equal(phasePallets("vendor_hub"), 3);
assert.equal(
  residualAllocationDrafts.flatMap((draft) => draft.lines)
    .reduce((sum, line) => sum + line.proposedPallets, 0),
  10,
  "Direct, internal-transfer, and vendor-hub residuals must partition one need without duplication."
);

const fourYards = [
  { locationId: 1, yardCode: "3445", requiredPallets: 3 },
  { locationId: 28, yardCode: "2967", requiredPallets: 5 },
  { locationId: 15, yardCode: "12441", requiredPallets: 7 },
  { locationId: 26, yardCode: "150", requiredPallets: 9 }
].map(({ locationId, yardCode, requiredPallets }) => {
  const state = hubDemandState(requiredPallets);
  state.key = `1354:${locationId}`;
  state.policy = { ...state.policy, location_id: locationId, yard_code: yardCode };
  return state;
});
const fourYardDrafts = smartScmBuildPlanningDrafts({
  states: fourYards,
  supplyMap: new Map([["1354", { status: "unknown", available_pallets: 0 }]]),
  settings
}).drafts;
assert.equal(
  fourYardDrafts.flatMap((draft) => draft.lines)
    .reduce((sum, line) => sum + line.proposedPallets, 0),
  fourYards.reduce((sum, state) => sum + state.requiredPallets, 0),
  "Summed coverage for one SKU across all four yards must not exceed summed required quantity."
);

const redirectedSameSkuLoads = smartScmPackWholePalletLines([
  {
    itemId: 1354,
    destinationLocationId: 1,
    destinationName: "3445",
    requiredPallets: 3,
    proposedPallets: 3,
    palletWeight: 10,
    lineWeight: 30,
    toPlt: 1,
    reason: {}
  },
  {
    itemId: 1354,
    destinationLocationId: 28,
    destinationName: "2967",
    requiredPallets: 2,
    proposedPallets: 2,
    palletWeight: 10,
    lineWeight: 20,
    toPlt: 1,
    reason: {}
  }
], 100, { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
const redirectedSameSkuLines = redirectedSameSkuLoads.flatMap((load) => load.lines);
assert.equal(
  redirectedSameSkuLines.length,
  1,
  "One physical hub receipt must remain one PO line for the same SKU."
);
assert.deepEqual(
  redirectedSameSkuLines[0].reason.destinationAllocations
    .map((allocation) => [allocation.yard, allocation.proposedPallets])
    .sort(([left], [right]) => left.localeCompare(right)),
  [["2967", 2], ["3445", 3]],
  "The physical hub line must retain an exact allocation ledger for each original yard."
);
assert.equal(redirectedSameSkuLines[0].proposedPallets, 5);

const priorityRepackedAllocationLoads = smartScmPackWholePalletLines([{
  ...redirectedSameSkuLines[0],
  urgent: true,
  urgencyLevel: "ultimate_urgent",
  urgencyScore: 100
}], 40, { proposalType: "PO", sourceName: "Alliance", maxStops: 2 });
const priorityRepackedAllocationLines = priorityRepackedAllocationLoads.flatMap((load) => load.lines);
assert.ok(
  priorityRepackedAllocationLines.every((line) => Math.abs(
    line.reason.destinationAllocations.reduce((sum, allocation) => sum + allocation.proposedPallets, 0)
      - line.proposedPallets
  ) < 0.000001),
  "Every priority-repacked physical line must conserve the total of its yard allocations."
);
const priorityRepackedByYard = new Map();
for (const line of priorityRepackedAllocationLines) {
  for (const allocation of line.reason.destinationAllocations) {
    priorityRepackedByYard.set(
      allocation.yard,
      (priorityRepackedByYard.get(allocation.yard) || 0) + allocation.proposedPallets
    );
  }
}
assert.deepEqual(
  [...priorityRepackedByYard].sort(([left], [right]) => left.localeCompare(right)),
  [["2967", 2], ["3445", 3]],
  "Priority repacking must preserve each yard's logical allocation exactly once."
);

const mixedHubReceiptDrafts = smartScmBuildPlanningDrafts({
  states: [hubDemandState(2), { ...structuredClone(remoteState), requiredPallets: 3 }],
  supplyMap: new Map([["1354", { status: "partial", available_pallets: 2 }]]),
  settings
}).drafts.filter((draft) => (
  draft.phase === "vendor_hub"
  || (draft.phase === "direct_vendor" && draft.lines[0].destinationName === "12441")
));
const mixedHubReceiptLoads = consolidateCompatibleDrafts(
  mixedHubReceiptDrafts,
  settings,
  "mixed-hub-receipt"
);
assert.equal(
  mixedHubReceiptLoads.length,
  1,
  "A direct 12441 quantity and a hub-routed quantity from the same vendor must share one physical load."
);
assert.equal(mixedHubReceiptLoads[0].phase, "direct_vendor");
assert.equal(mixedHubReceiptLoads[0].lines.length, 1);
assert.equal(mixedHubReceiptLoads[0].lines[0].proposedPallets, 3);
assert.deepEqual(
  mixedHubReceiptLoads[0].lines[0].reason.destinationAllocations,
  [
    { yard: "3445", proposedPallets: 1, fulfillment: "transfer_later" },
    { yard: "12441", proposedPallets: 2, fulfillment: "vendor_direct" }
  ],
  "The combined physical line must distinguish direct hub demand from later-transfer demand."
);

const supplyCases = [
  { status: "unknown", available: 0 },
  { status: "available", available: 100 },
  { status: "production_eta", available: 0 },
  { status: "partial", available: 0 },
  { status: "partial", available: 7 },
  { status: "out_of_stock", available: 0 },
  { status: "credit_hold", available: 0 }
];

let propertyCases = 0;
for (let requiredPallets = 1; requiredPallets <= 25; requiredPallets += 1) {
  for (const supply of supplyCases) {
    const drafts = planningDrafts({
      requiredPallets,
      supplyStatus: supply.status,
      vendorAvailablePallets: supply.available
    });
    const poDrafts = drafts.filter((draft) => draft.proposalType === "PO");
    const poPallets = poDrafts
      .flatMap((draft) => draft.lines)
      .reduce((sum, line) => sum + line.proposedPallets, 0);
    const expectedDirectPallets = ["out_of_stock", "credit_hold"].includes(supply.status)
      ? 0
      : supply.status === "partial"
        ? Math.min(requiredPallets, supply.available)
        : requiredPallets;
    assert.equal(
      poDrafts.some((draft) => draft.phase === "vendor_hub"),
      false,
      `Hub demand must not loop through vendor_hub for ${supply.status}, ${requiredPallets} PLT.`
    );
    assert.equal(
      poPallets,
      expectedDirectPallets,
      `PO quantity must conserve the vendor-suppliable hub demand for ${supply.status}, ${requiredPallets} PLT.`
    );
    propertyCases += 1;
  }
}

console.log(`Smart SCM purchase conservation harness passed: ${propertyCases} property cases.`);

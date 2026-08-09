import assert from "node:assert/strict";
import { validateSmartScmPlanningRunSnapshot } from "./smart-scm-run-validator.js";

function state({
  itemId = 5001,
  yardCode = "3445",
  locationId = 1,
  requiredPallets = 10,
  positionPallets = 0,
  rop = 5,
  preferred = 10,
  capacity = 25,
  minimumOrder = 1,
  availablePallets = 0,
  urgent = true
} = {}) {
  return {
    key: `${itemId}:${locationId}`,
    policy: { item_id: itemId, item_name: `ITEM-${itemId}`, yard_code: yardCode, location_id: locationId },
    requiredPallets,
    positionPallets,
    rop,
    preferred,
    capacity,
    minimumOrder,
    capacityBelowMinimum: false,
    availablePallets,
    urgent
  };
}

function line(itemId, destinationName, proposedPallets, {
  actualDestinationYard = null,
  destinationAllocations = null,
  urgent = true
} = {}) {
  return {
    itemId,
    itemName: `ITEM-${itemId}`,
    destinationName,
    proposedPallets,
    urgent,
    reason: {
      ...(actualDestinationYard ? { actualDestinationYard } : {}),
      ...(destinationAllocations ? { destinationAllocations } : {})
    }
  };
}

function proposal(id, phase, lines) {
  return { id, phase, status: "held", proposalType: phase === "internal_transfer" ? "TO" : "PO", lines };
}

const goodStates = [
  state(),
  state({ itemId: 5001, yardCode: "2967", locationId: 28, requiredPallets: 0,
    positionPallets: 12, rop: 5, preferred: 10, availablePallets: 12, urgent: false })
];
const goodProposals = [
  proposal(1, "direct_vendor", [line(5001, "3445", 2)]),
  proposal(2, "internal_transfer", [line(5001, "3445", 5)]),
  proposal(3, "vendor_hub", [line(5001, "12441", 3, { actualDestinationYard: "3445" })])
];
const good = validateSmartScmPlanningRunSnapshot({ states: goodStates, proposals: goodProposals });
assert.equal(good.passed, true, "A conserved three-phase plan must pass validation.");
assert.equal(good.summary.stateCount, 2);
assert.equal(good.summary.shortageStateCount, 1);
assert.equal(good.summary.totalRequiredPallets, 10);
assert.equal(good.summary.totalProposedPallets, 10);
assert.equal(good.summary.zeroAvailableShortageCount, 1);
assert.equal(good.summary.zeroAvailableNotUrgentCount, 0);
assert.equal(good.summary.coverageAboveRequiredCount, 0);
assert.equal(good.summary.skuCoverageAboveRequiredCount, 0);
assert.equal(good.summary.maximumFinalAbovePslPallets, 0,
  "Existing overstock without a new proposal must not inflate the proposal overshoot metric.");

const allocatedHubLine = validateSmartScmPlanningRunSnapshot({
  states: [
    state({ requiredPallets: 3, preferred: 3, rop: 1 }),
    state({ yardCode: "2967", locationId: 28, requiredPallets: 2, preferred: 2, rop: 1 })
  ],
  proposals: [proposal(4, "direct_vendor", [line(5001, "12441", 5, {
    destinationAllocations: [
      { yard: "3445", proposedPallets: 3 },
      { yard: "2967", proposedPallets: 2 }
    ]
  })])]
});
assert.equal(
  allocatedHubLine.passed,
  true,
  "One physical hub line with an exact two-yard allocation ledger must validate per yard."
);
assert.equal(allocatedHubLine.summary.coverageAboveRequiredCount, 0);
assert.equal(allocatedHubLine.summary.skuCoverageAboveRequiredCount, 0);

const malformedAllocation = validateSmartScmPlanningRunSnapshot({
  states: [state()],
  proposals: [proposal(5, "direct_vendor", [line(5001, "12441", 10, {
    destinationAllocations: [{ yard: "3445", proposedPallets: 9 }]
  })])]
});
assert.ok(
  malformedAllocation.failures.some((failure) => failure.code === "destination_allocation_total_mismatch"),
  "The validator must reject an allocation ledger that does not conserve its physical line quantity."
);

const duplicated = validateSmartScmPlanningRunSnapshot({
  states: [state()],
  proposals: [
    proposal(10, "direct_vendor", [line(5001, "3445", 10)]),
    proposal(11, "vendor_hub", [line(5001, "12441", 10, { actualDestinationYard: "3445" })])
  ]
});
assert.equal(duplicated.passed, false);
assert.ok(duplicated.failures.some((failure) => failure.code === "coverage_exceeds_required"),
  "Per-yard duplicate coverage must be detected.");
assert.ok(duplicated.failures.some((failure) => failure.code === "sku_coverage_exceeds_required"),
  "Four-yard SKU duplicate coverage must be detected.");

const staleUrgency = validateSmartScmPlanningRunSnapshot({
  states: [state({ urgent: false })],
  proposals: [proposal(20, "direct_vendor", [line(5001, "3445", 10, { urgent: false })])]
});
assert.equal(staleUrgency.passed, false);
assert.ok(staleUrgency.failures.some((failure) => failure.code === "zero_available_not_urgent"),
  "A stale state-level zero-stock urgency must be detected.");
assert.ok(staleUrgency.failures.some((failure) => failure.code === "zero_available_line_not_urgent"),
  "A stale proposal-line zero-stock urgency must be detected.");

const selfHub = validateSmartScmPlanningRunSnapshot({
  states: [state({ yardCode: "12441", locationId: 15 })],
  proposals: [proposal(30, "vendor_hub", [line(5001, "12441", 10, { actualDestinationYard: "12441" })])]
});
assert.equal(selfHub.passed, false, "A self-hub proposal must fail validation.");
assert.ok(selfHub.failures.some((failure) => failure.code === "self_hub_vendor_po"),
  "A 12441-to-12441 vendor-hub line must be detected.");

const farAbovePsl = validateSmartScmPlanningRunSnapshot({
  states: [state({ requiredPallets: 20, preferred: 10, minimumOrder: 2 })],
  proposals: [proposal(40, "direct_vendor", [line(5001, "3445", 20)])]
});
assert.equal(farAbovePsl.passed, false);
assert.ok(farAbovePsl.failures.some((failure) => failure.code === "final_position_far_above_psl"),
  "A proposal that finishes materially above PSL must be detected.");

console.log("Smart SCM planning-run validator harness passed.");

import assert from "node:assert/strict";
import test from "node:test";

import {
  smartScmAllocateBlanketCoverage,
  smartScmBlanketCoverageSnapshot,
  smartScmBlanketDemandCompare
} from "../../../src/smart-scm-blanket-coverage.js";
import {
  smartScmBuildPlanningDrafts,
  smartScmBuildTransferPhaseDrafts
} from "../../../src/smart-scm-planning-repository.js";
import { smartScmBlanketDraftGroupsForPlanning } from "../../../src/smart-scm-blanket-repository.js";

const ITEM_ID = 990501;

function planningState({
  locationId = 1,
  yardCode = "3445",
  requiredPallets = 50,
  availablePallets = 0,
  blanketCoveragePallets = 1,
  residualRequiredPallets = 49,
  temporarilyExcluded = false
} = {}) {
  return {
    key: `${ITEM_ID}:${locationId}`,
    requiredPallets,
    blanketCoveragePallets,
    residualRequiredPallets,
    availablePallets,
    onHandSales: availablePallets * 10,
    availableSales: availablePallets * 10,
    onOrderSales: 0,
    positionPallets: availablePallets,
    safety: 0,
    rop: 0,
    preferred: requiredPallets,
    capacity: 100,
    minimumOrder: 1,
    weeklyDemand: 10,
    leadWeeks: 1,
    manualPlanningRequired: false,
    urgent: true,
    urgencyLevel: "urgent",
    urgencyScore: 100,
    policy: {
      item_id: ITEM_ID,
      item_name: "Blanket residual fixture",
      item_description: "Residual planning regression",
      stock_unit: "EA",
      location_id: locationId,
      yard_code: yardCode,
      to_plt: 10,
      to_lyr: 0,
      to_sec: 0,
      to_pcs: 0,
      pallet_weight_lbs: 1000,
      physical_pallet_weight_lbs: 0,
      vendor: "Residual Vendor",
      plant: "Residual Vendor Yard",
      temporarily_excluded: temporarilyExcluded
    }
  };
}

const settings = {
  truck_capacity_lbs: 78000,
  hold_load_ratio: 0.5,
  vendor_response_sla_hours: 24,
  skip_12441_enabled: false
};

function materialPallets(drafts) {
  return drafts.flatMap((draft) => draft.lines || [])
    .reduce((sum, line) => sum + Number(line.proposedPallets || 0), 0);
}

function blanketPoolRow({
  sourcePoId = 7001,
  sourcePoRef = "PO-BLANKET-1",
  sourceLineId = 8001,
  itemId = ITEM_ID,
  toPlt = 10,
  remainingPallets = 1,
  trandate = "2026-01-01"
} = {}) {
  return {
    source_po_id: sourcePoId,
    source_po_ref: sourcePoRef,
    source_line_id: sourceLineId,
    item_id: itemId,
    to_plt: toPlt,
    remaining_pallets: remainingPallets,
    trandate,
    pickup_point: "Residual Vendor Yard",
    vendor: "Residual Vendor"
  };
}

test("Blanket allocation turns 50 required and 1 available into a 49 PLT residual", () => {
  const result = smartScmAllocateBlanketCoverage({
    states: [planningState()],
    poolRows: [blanketPoolRow()]
  });

  assert.equal(result.states[0].blanketCoveragePallets, 1);
  assert.equal(result.states[0].residualRequiredPallets, 49);
  assert.deepEqual(result.states[0].blanketSourcePoRefs, ["PO-BLANKET-1"]);
  assert.equal(result.allocations[0].pallets, 1);
  assert.equal(result.allocations[0].sourceLineId, 8001);
});

test("Blanket allocation prioritizes urgency and conserves one pool across yards", () => {
  const normal = planningState({
    locationId: 1,
    yardCode: "3445",
    requiredPallets: 4,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 4
  });
  normal.urgencyLevel = "normal";
  normal.urgencyScore = 1;
  const urgent = planningState({
    locationId: 28,
    yardCode: "2967",
    requiredPallets: 2,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 2
  });
  urgent.urgencyLevel = "super_urgent";
  urgent.urgencyScore = 10;

  const result = smartScmAllocateBlanketCoverage({
    states: [normal, urgent],
    poolRows: [blanketPoolRow({ remainingPallets: 3 })]
  });
  const byLocation = new Map(result.states.map((state) => [state.policy.location_id, state]));

  assert.equal(byLocation.get(28).blanketCoveragePallets, 2);
  assert.equal(byLocation.get(28).residualRequiredPallets, 0);
  assert.equal(byLocation.get(1).blanketCoveragePallets, 1);
  assert.equal(byLocation.get(1).residualRequiredPallets, 3);
  assert.equal(result.allocations.reduce((sum, allocation) => sum + allocation.pallets, 0), 3);
});

test("equal urgency uses score descending and then location ID ascending", () => {
  const states = [
    planningState({ locationId: 15, yardCode: "12441", requiredPallets: 1 }),
    planningState({ locationId: 1, yardCode: "3445", requiredPallets: 1 }),
    planningState({ locationId: 28, yardCode: "2967", requiredPallets: 1 })
  ];
  states.forEach((state) => {
    state.urgencyLevel = "urgent";
    state.urgencyScore = state.policy.location_id === 28 ? 20 : 10;
  });
  const result = smartScmAllocateBlanketCoverage({
    states,
    poolRows: [blanketPoolRow({ remainingPallets: 2 })]
  });
  const coveredLocations = result.states
    .filter((state) => state.blanketCoveragePallets > 0)
    .map((state) => state.policy.location_id)
    .sort((left, right) => left - right);

  assert.deepEqual(coveredLocations, [1, 28]);
});

test("Blanket allocation is whole-pallet, conversion-compatible, oldest-first, and skips manual pauses", () => {
  const fractional = planningState({
    requiredPallets: 1.5,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 1.5
  });
  const paused = planningState({
    locationId: 28,
    yardCode: "2967",
    requiredPallets: 5,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 5,
    temporarilyExcluded: true
  });
  paused.urgencyLevel = "ultimate_urgent";
  const result = smartScmAllocateBlanketCoverage({
    states: [paused, fractional],
    poolRows: [
      blanketPoolRow({ sourcePoId: 7003, sourcePoRef: "PO-NEW", sourceLineId: 8003, remainingPallets: 5, trandate: "2026-03-01" }),
      blanketPoolRow({ sourcePoId: 7002, sourcePoRef: "PO-WRONG-UOM", sourceLineId: 8002, toPlt: 12, remainingPallets: 5, trandate: "2025-01-01" }),
      blanketPoolRow({ sourcePoId: 7001, sourcePoRef: "PO-OLD", sourceLineId: 8001, remainingPallets: 1, trandate: "2026-01-01" })
    ]
  });
  const byLocation = new Map(result.states.map((state) => [state.policy.location_id, state]));

  assert.equal(byLocation.get(28).blanketCoveragePallets, 0);
  assert.equal(byLocation.get(1).blanketCoveragePallets, 1);
  assert.equal(byLocation.get(1).residualRequiredPallets, 0.5);
  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].sourcePoRef, "PO-OLD");
});

test("50 PLT demand with 1 PLT Blanket coverage creates a 49 PLT PO residual", () => {
  const calculated = smartScmBuildPlanningDrafts({
    states: [planningState()],
    supplyMap: new Map(),
    settings
  });

  assert.equal(calculated.drafts.every((draft) => draft.proposalType === "PO"), true);
  assert.equal(materialPallets(calculated.drafts), 49);
  assert.equal(calculated.drafts[0].lines[0].requiredPallets, 50);
  assert.equal(calculated.drafts[0].lines[0].reason.blanketCoveragePallets, 1);
  assert.equal(calculated.drafts[0].lines[0].reason.residualRequiredPallets, 49);
});

test("50 PLT demand with 1 PLT Blanket coverage caps TO routing at the 49 PLT residual", () => {
  const destination = planningState();
  const source = planningState({
    locationId: 28,
    yardCode: "2967",
    requiredPallets: 0,
    availablePallets: 60,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 0
  });
  const calculated = smartScmBuildPlanningDrafts({
    states: [destination, source],
    supplyMap: new Map([[String(ITEM_ID), { status: "out_of_stock", available_pallets: 0 }]]),
    settings
  });

  assert.equal(calculated.drafts.every((draft) => draft.proposalType === "TO"), true);
  assert.equal(materialPallets(calculated.drafts), 49);
  assert.equal(source.availablePallets, 11);
});

test("full Blanket coverage creates no ordinary PO or TO proposal", () => {
  const calculated = smartScmBuildPlanningDrafts({
    states: [planningState({ blanketCoveragePallets: 50, residualRequiredPallets: 0 })],
    supplyMap: new Map(),
    settings
  });

  assert.deepEqual(calculated.drafts, []);
});

test("phased transfer planning also caps replenishment at the uncovered residual", () => {
  const destination = planningState();
  const source = planningState({
    locationId: 28,
    yardCode: "2967",
    requiredPallets: 0,
    availablePallets: 60,
    blanketCoveragePallets: 0,
    residualRequiredPallets: 0
  });
  const calculated = smartScmBuildTransferPhaseDrafts({
    states: [destination, source],
    settings
  });

  assert.equal(calculated.drafts.every((draft) => draft.proposalType === "TO"), true);
  assert.equal(materialPallets(calculated.drafts), 49);
  assert.equal(source.availablePallets, 11);
});

test("coverage snapshot preserves required, covered, residual, and source metadata", () => {
  const snapshot = smartScmBlanketCoverageSnapshot([
    {
      ...planningState(),
      blanketSourcePoRefs: ["PO-BLANKET-1"]
    },
    planningState({
      locationId: 28,
      yardCode: "2967",
      requiredPallets: 0,
      blanketCoveragePallets: 0,
      residualRequiredPallets: 0
    })
  ]);

  assert.equal(snapshot.blanketCoveredLines, 1);
  assert.equal(snapshot.blanketCoveredPallets, 1);
  assert.equal(snapshot.residualRequiredPallets, 49);
  assert.deepEqual(snapshot.blanketCoverage, [{
    key: `${ITEM_ID}:1`,
    itemId: ITEM_ID,
    locationId: 1,
    yard: "3445",
    requiredPallets: 50,
    coveredPallets: 1,
    residualPallets: 49,
    sourcePoRefs: ["PO-BLANKET-1"]
  }]);
});

test("Blanket release drafts and ordinary planning consume the same allocation ledger", () => {
  const allocation = smartScmAllocateBlanketCoverage({
    states: [planningState()],
    poolRows: [blanketPoolRow()]
  });
  const groups = smartScmBlanketDraftGroupsForPlanning({ states: allocation.states });
  const ordinary = smartScmBuildPlanningDrafts({
    states: allocation.states,
    supplyMap: new Map(),
    settings
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].lines.length, 1);
  assert.equal(groups[0].lines[0].proposedPallets, 1);
  assert.equal(groups[0].lines[0].reason.blanketSourceLineId, 8001);
  assert.equal(materialPallets(ordinary.drafts), 49);
});

test("allocator handles legacy camel-case rows, fallback priority fields, and invalid edge shapes", () => {
  assert.ok(smartScmBlanketDemandCompare(
    { urgency_level: "urgent", urgency_score: 5, policy: { location_id: 2 } },
    { urgent: true, urgency_score: 1, policy: { location_id: 1 } }
  ) < 0);
  assert.ok(smartScmBlanketDemandCompare(
    { urgency_score: 1, policy: { location_id: 2 } },
    { urgency_score: 2, policy: { location_id: 1 } }
  ) > 0);
  assert.equal(smartScmBlanketDemandCompare({}, {}), 0);
  assert.deepEqual(smartScmAllocateBlanketCoverage(), { states: [], allocations: [], coverage: [] });
  assert.deepEqual(smartScmAllocateBlanketCoverage({ states: null, poolRows: null }), {
    states: [], allocations: [], coverage: []
  });
  assert.deepEqual(smartScmBlanketCoverageSnapshot(null), {
    blanketCoverage: [],
    blanketCoveredLines: 0,
    blanketCoveredPallets: 0,
    residualRequiredPallets: 0
  });

  const itemId = ITEM_ID + 1;
  const state = {
    requiredPallets: 4,
    urgency_level: "normal",
    urgency_score: 0,
    policy: { item_id: itemId, location_id: 1, to_plt: 10 }
  };
  const camelPool = [
    { sourcePoId: 2, sourceLineId: 3, itemId, toPlt: 10, remainingPallets: 1, transactionDate: "invalid" },
    { sourcePoId: 1, sourceLineId: 2, itemId, toPlt: 10, remainingPallets: 1, transactionDate: "invalid" },
    { sourcePoId: 1, sourceLineId: 1, sourcePoRef: "CAMEL-PO", itemId, toPlt: 10, remainingPallets: 1 },
    { sourcePoId: 1, sourceLineId: 1, itemId, toPlt: 10, remainingPallets: 1 }
  ];
  const result = smartScmAllocateBlanketCoverage({ states: [state], poolRows: camelPool });

  assert.equal(result.states[0].key, undefined);
  assert.equal(result.states[0].blanketCoveragePallets, 4);
  assert.equal(result.states[0].residualRequiredPallets, 0);
  assert.deepEqual(result.states[0].blanketSourcePoRefs, ["CAMEL-PO"]);
  assert.deepEqual(result.allocations.map((allocation) => allocation.sourcePoId), [1, 1, 1, 2]);
  assert.equal(result.coverage[0].key, `${itemId}:1`);
  assert.equal(result.coverage[0].yard, "");

  const invalidStates = smartScmAllocateBlanketCoverage({
    states: [
      { requiredPallets: 1, policy: { location_id: 1, to_plt: 10 } },
      { requiredPallets: 1, policy: { item_id: itemId, to_plt: 10 } },
      { requiredPallets: 1, policy: { item_id: itemId, location_id: 1, to_plt: 0 } }
    ],
    poolRows: camelPool
  });
  assert.equal(invalidStates.states.every((entry) => entry.blanketCoveragePallets === 0), true);
});

import assert from "node:assert/strict";
import {
  calculatePolicyState,
  classifySmartScmUrgency,
  smartScmPackWholePalletLines,
  smartScmUrgencySummary
} from "./smart-scm-planning-repository.js";

const zeroAvailableShortage = calculatePolicyState({
  item_id: 999001,
  item_name: "ZERO-AVAILABLE-URGENCY",
  location_id: 1,
  yard_code: "3445",
  stock_unit: "EA",
  to_plt: 10,
  pallet_weight_lbs: 1000,
  capacity_pallets: 25,
  minimum_safety_pallets: 1,
  effective_lead_time_days: 7,
  service_quantile: 0.9
}, {
  authoritative_model: "formula",
  formula_weekly_demand: 5,
  baseline_weekly: 5,
  formula_weekly_sd: 0
}, {
  balanceMap: new Map([["999001:1", {
    quantity_on_hand: 0,
    quantity_available: 0,
    quantity_on_order: 58,
    quantity_backordered: 0
  }]]),
  blanketExcludedMap: new Map(),
  excludedTransferOrderMap: new Map(),
  reservedBlanketMap: new Map(),
  outboundReservationMap: new Map(),
  inboundReservationMap: new Map()
}, 1, {
  pickup_safety_factor: 1.3,
  delivery_safety_factor: 1.645
});
assert.equal(zeroAvailableShortage.availablePallets, 0);
assert.equal(zeroAvailableShortage.positionPallets, 5.8);
assert.equal(zeroAvailableShortage.rop, 6);
assert.equal(zeroAvailableShortage.requiredPallets, 6);
assert.equal(
  zeroAvailableShortage.urgent,
  true,
  "Zero available stock with a positive calculated need must always be urgent, even when inbound raises projected position."
);

function state(locationId, weeklyDemand, { urgent = true, availableSales = 0 } = {}) {
  return {
    policy: { location_id: locationId },
    weeklyDemand,
    urgent,
    rawAvailableSales: availableSales,
    availableSales
  };
}

const yardStates = [1, 2, 3, 4, 5].map((demand) => state(1, demand));
classifySmartScmUrgency(yardStates);
assert.deepEqual(yardStates.map((entry) => entry.urgencyScore), [0, 25, 50, 75, 100]);
assert.deepEqual(yardStates.map((entry) => entry.urgencyLevel), [
  "urgent", "urgent", "super_urgent", "super_urgent", "ultimate_urgent"
]);

const availableUrgent = state(28, 100, { availableSales: 1 });
const nonUrgent = state(28, 50, { urgent: false });
classifySmartScmUrgency([availableUrgent, nonUrgent]);
assert.equal(availableUrgent.urgencyLevel, "urgent", "available stock must retain legacy urgent instead of escalating");
assert.equal(nonUrgent.urgencyLevel, "normal", "a non-urgent policy state must stay normal");

assert.deepEqual(smartScmUrgencySummary([
  { urgent: true, urgencyLevel: "urgent", urgencyScore: 99 },
  { urgent: true, urgencyLevel: "ultimate_urgent", urgencyScore: 85 }
]), { urgent: true, urgencyLevel: "ultimate_urgent", urgencyScore: 85 });

function line(itemId, destinationLocationId, proposedPallets, palletWeight, urgencyLevel, urgencyScore) {
  return {
    itemId,
    itemName: `Item ${itemId}`,
    destinationLocationId,
    destinationName: String(destinationLocationId),
    requiredPallets: proposedPallets,
    proposedPallets,
    confirmedPallets: 0,
    residualPallets: proposedPallets,
    salesQuantity: proposedPallets * 10,
    palletWeight,
    physicalPalletWeightLbs: 5,
    lineWeight: proposedPallets * palletWeight,
    urgencyLevel,
    urgencyScore,
    urgent: urgencyLevel !== "normal",
    provisional: false,
    reason: {}
  };
}

const inputLines = [
  line(101, 1, 3, 25, "ultimate_urgent", 95),
  line(102, 1, 2, 20, "super_urgent", 70),
  line(103, 28, 4, 15, "normal", 0),
  line(104, 28, 1, 30, "urgent", 45)
];
const packed = smartScmPackWholePalletLines(inputLines, 100, {
  proposalType: "PO",
  sourceName: "Test vendor",
  maxStops: 2,
  routeRule: {
    enabled: true,
    maxDrops: 2,
    stopOrder: [1, 28, 15, 26],
    partialRedirectEnabled: false
  }
});
assert.ok(packed.length > 0);
assert.ok(packed.every((load) => load.totalWeight <= 100));
assert.ok(packed.every((load) => load.routeStops.length <= 2));

const totals = packed.flatMap((load) => load.lines).reduce((result, packedLine) => {
  const current = result.get(packedLine.itemId) || { required: 0, proposed: 0 };
  current.required += packedLine.requiredPallets;
  current.proposed += packedLine.proposedPallets;
  result.set(packedLine.itemId, current);
  return result;
}, new Map());
for (const input of inputLines) {
  assert.equal(totals.get(input.itemId)?.required, input.requiredPallets, `required pallets must be conserved for ${input.itemId}`);
  assert.equal(totals.get(input.itemId)?.proposed, input.proposedPallets, `proposed pallets must be conserved for ${input.itemId}`);
}

const singleDrop = smartScmPackWholePalletLines([
  line(201, 1, 1, 20, "ultimate_urgent", 100),
  line(202, 28, 1, 20, "super_urgent", 60)
], 100, {
  proposalType: "PO",
  sourceName: "One-drop vendor",
  maxStops: 2,
  routeRule: {
    enabled: true,
    maxDrops: 1,
    stopOrder: [1, 28, 15, 26],
    partialRedirectEnabled: false
  }
});
assert.equal(singleDrop.length, 2);
assert.ok(singleDrop.every((load) => load.routeStops.length === 1));

console.log("Smart SCM urgency harness passed.");

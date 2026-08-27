import assert from "node:assert/strict";
import test from "node:test";

import {
  smartScmApplySkip12441Policy,
  smartScmAutomaticDestinationAllowed,
  smartScmBuild12441DemandProjection
} from "../../../src/smart-scm-skip-12441.js";

const fact = (itemId, documentRef, quantity, locationId = 15) => ({
  itemId,
  locationId,
  documentRef,
  deliveryMethod: locationId === 15 ? "delivery" : "pickup",
  quantity,
  weekStart: "2026-08-03"
});

function quantityAt(result, itemId, locationId) {
  return result.facts
    .filter((row) => Number(row.itemId) === itemId && Number(row.locationId) === locationId)
    .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
}

test("all 12441 demand uses the normalized SOB:SOA ratio and remains conserved", () => {
  const result = smartScmBuild12441DemandProjection({
    enabled: true,
    facts: [fact(101, "SOB001", 60), fact(101, "SOA001", 30), fact(101, "SOM001", 10)]
  });

  assert.equal(quantityAt(result, 101, 15), 0);
  assert.equal(quantityAt(result, 101, 1), 66.666667);
  assert.equal(quantityAt(result, 101, 28), 33.333333);
  assert.equal(quantityAt(result, 101, 1) + quantityAt(result, 101, 28), 100);
  assert.equal(result.allocations[0].ratioSource, "item");
  assert.equal(result.allocations[0].originalQuantity, 100);
});

test("missing item attribution uses the company ratio and finally 50:50", () => {
  const company = smartScmBuild12441DemandProjection({
    enabled: true,
    facts: [
      fact(201, "SOB-COMPANY", 75),
      fact(201, "SOA-COMPANY", 25),
      fact(202, "SOM-UNKNOWN", 20)
    ]
  });
  assert.equal(quantityAt(company, 202, 1), 15);
  assert.equal(quantityAt(company, 202, 28), 5);
  assert.equal(company.allocations.find((row) => row.itemId === 202).ratioSource, "company");

  const equal = smartScmBuild12441DemandProjection({
    enabled: true,
    facts: [fact(301, "SOM-ONLY", 9)]
  });
  assert.equal(quantityAt(equal, 301, 1), 4.5);
  assert.equal(quantityAt(equal, 301, 28), 4.5);
  assert.equal(equal.allocations[0].ratioSource, "equal");
});

test("disabled projection preserves the existing fact set", () => {
  const facts = [fact(401, "SOB-OFF", 8), fact(402, "SOA-OTHER", 3, 1)];
  const result = smartScmBuild12441DemandProjection({ enabled: false, facts });
  assert.deepEqual(result.facts, facts);
  assert.deepEqual(result.allocations, []);
});

test("12441 policy values and destination requirement are exactly zero", () => {
  const original = {
    key: "501:15",
    policy: { item_id: 501, location_id: 15, yard_code: "12441" },
    safety: 4,
    rop: 7,
    preferred: 12,
    baseRop: 6,
    basePreferred: 10,
    requiredPallets: 8,
    minimumOrder: 2
  };
  const skipped = smartScmApplySkip12441Policy(original, { enabled: true });
  assert.deepEqual({
    safety: skipped.safety,
    rop: skipped.rop,
    preferred: skipped.preferred,
    baseRop: skipped.baseRop,
    basePreferred: skipped.basePreferred,
    requiredPallets: skipped.requiredPallets,
    sourceProtectedFloorPallets: skipped.sourceProtectedFloorPallets
  }, {
    safety: 0,
    rop: 0,
    preferred: 0,
    baseRop: 0,
    basePreferred: 0,
    requiredPallets: 0,
    sourceProtectedFloorPallets: 0
  });
  assert.equal(smartScmApplySkip12441Policy(original, { enabled: false }), original);
});

test("12441 forecast policy visibility cannot retain an active coverage floor", () => {
  const levels = {
    policy: { location_id: 15, yard_code: "12441" },
    weeklyDemandPallets: 8,
    weeklyDemandSdPallets: 2,
    configuredMinimumSafetyPallets: 3,
    effectiveMinimumSafetyPallets: 3,
    standardSafetyStockPallets: 4,
    safetyStockPallets: 4,
    standardReorderPointPallets: 12,
    baseReorderPointPallets: 12,
    reorderPointPallets: 15,
    standardPreferredPallets: 20,
    basePreferredPallets: 20,
    preferredPallets: 20,
    coverageFloorPallets: 15,
    zeroDemandCoverageApplied: true,
    lowerStockPolicyApplied: true
  };
  const skipped = smartScmApplySkip12441Policy(levels, { enabled: true });
  for (const key of [
    "weeklyDemandPallets", "weeklyDemandSdPallets",
    "configuredMinimumSafetyPallets", "effectiveMinimumSafetyPallets",
    "standardSafetyStockPallets", "safetyStockPallets",
    "standardReorderPointPallets", "baseReorderPointPallets", "reorderPointPallets",
    "standardPreferredPallets", "basePreferredPallets", "preferredPallets",
    "coverageFloorPallets"
  ]) {
    assert.equal(skipped[key], 0, `${key} must be visibly zero while 12441 is skipped`);
  }
  assert.equal(skipped.zeroDemandCoverageApplied, false);
  assert.equal(skipped.lowerStockPolicyApplied, false);
});

test("skip mode rejects every automatic 12441 destination but keeps other yards", () => {
  assert.equal(smartScmAutomaticDestinationAllowed(15, { skip12441Enabled: true }), false);
  assert.equal(smartScmAutomaticDestinationAllowed("12441", { skip12441Enabled: true }), false);
  assert.equal(smartScmAutomaticDestinationAllowed(1, { skip12441Enabled: true }), true);
  assert.equal(smartScmAutomaticDestinationAllowed(15, { skip12441Enabled: false }), true);
});

test("snake-case forecast facts are projected without changing non-12441 facts", () => {
  const preserved = {
    item_id: 601,
    location_id: 1,
    document_ref: "SOB-PRESERVED",
    delivery_method: "pickup",
    demand_quantity: 3
  };
  const result = smartScmBuild12441DemandProjection({
    enabled: true,
    facts: [
      preserved,
      {
        item_id: 601,
        location_id: 15,
        document_ref: "SOA-SNAKE",
        delivery_method: "delivery",
        demand_quantity: 7
      }
    ]
  });
  assert.equal(result.facts.includes(preserved), true);
  const projected = result.facts.filter((row) => row.skip12441Projection === true);
  assert.equal(projected.length, 2);
  assert.equal(projected.every((row) => row.delivery_method === "pickup"), true);
  assert.equal(projected.every((row) => row.document_ref.startsWith("SKIP12441-")), true);
  assert.equal(projected.reduce((sum, row) => sum + row.demand_quantity, 0), 7);
});

test("skip policy accepts yard-code aliases and leaves other yards unchanged", () => {
  const direct = { yardCode: "12441", requiredPallets: 5, sourceProtectedFloorPallets: 4 };
  assert.equal(smartScmApplySkip12441Policy(direct, { enabled: true }).requiredPallets, 0);
  const other = { policy: { location_id: 1, yard_code: "3445" }, requiredPallets: 5 };
  assert.equal(smartScmApplySkip12441Policy(other, { enabled: true }), other);
  assert.equal(smartScmApplySkip12441Policy(null, { enabled: true }), null);
});

import assert from "node:assert/strict";
import { calculateSmartScmPolicyLevels } from "./smart-scm-policy-calculation.js";

const bh80 = calculateSmartScmPolicyLevels({
  yard_code: "150",
  effective_lead_time_days: 14,
  capacity_pallets: 16,
  service_quantile: 0.90,
  minimum_safety_pallets: 2
}, {
  authoritative_model: "formula",
  formula_weekly_demand: 4,
  formula_weekly_sd: 1.632993,
  p50_weekly: 1,
  p90_weekly: 2.80491,
  zero_demand_coverage_applied: false,
  coverage_floor_pallets: 4
}, {
  pickup_safety_factor: 1.3,
  delivery_safety_factor: 1.645
});

assert(Math.abs(bh80.safetyStockPallets - 3.002221) < 0.00001);
assert.equal(bh80.leadWeeks, 2);
assert.equal(bh80.weeklyDemandPallets, 4);
assert.equal(bh80.reorderPointPallets, 11);
assert.equal(bh80.preferredPallets, 16);
assert.equal(bh80.capacityPallets, 16);

const inactiveCoverage = calculateSmartScmPolicyLevels({
  yard_code: "150",
  effective_lead_time_days: 7,
  capacity_pallets: 16,
  minimum_safety_pallets: 2
}, {
  authoritative_model: "formula",
  formula_weekly_demand: 0,
  formula_weekly_sd: 0,
  zero_demand_coverage_applied: false,
  coverage_floor_pallets: 8
}, { pickup_safety_factor: 1.3 });
assert.equal(inactiveCoverage.reorderPointPallets, 2, "Inactive coverage evidence must not change ROP.");

const activeCoverage = calculateSmartScmPolicyLevels({
  yard_code: "150",
  effective_lead_time_days: 7,
  capacity_pallets: 6,
  minimum_safety_pallets: 2
}, {
  authoritative_model: "formula",
  formula_weekly_demand: 0,
  formula_weekly_sd: 0,
  zero_demand_coverage_applied: true,
  coverage_floor_pallets: 8
}, { pickup_safety_factor: 1.3 });
assert.equal(activeCoverage.reorderPointPallets, 8, "Active coverage must raise ROP to its saved floor.");
assert.equal(activeCoverage.preferredPallets, 6, "Preferred stock must remain capacity-capped.");

const predicted = calculateSmartScmPolicyLevels({
  yard_code: "12441",
  effective_lead_time_days: 14,
  capacity_pallets: 20,
  service_quantile: 0.95,
  minimum_safety_pallets: 2
}, {
  authoritative_model: "seasonal",
  baseline_weekly: 3,
  p50_weekly: 4,
  p90_weekly: 6,
  p95_weekly: 7,
  lead_time_p90: 9,
  lead_time_p95: 12,
  zero_demand_coverage_applied: false
}, { delivery_safety_factor: 1.645 });
assert.equal(predicted.reorderPointPallets, 12);
assert.equal(predicted.preferredPallets, 19);
assert.equal(predicted.safetyStockPallets, 4);
assert.equal(predicted.forecastModel, "seasonal");
assert.equal(predicted.usesPrediction, true);

console.log("Smart SCM policy calculation harness passed.");

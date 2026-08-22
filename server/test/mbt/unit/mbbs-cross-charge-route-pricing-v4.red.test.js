// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateDistanceBandChargeMinor,
  distanceBandContains,
  normalizedBoundaryRule,
  normalizedDistancePricingBasis
} from "../../../src/mbt/distance-band-pricing.js";
import {
  calculateMbbsCrossCharges
} from "../../../src/mbt/local-billing-calculator.js";
import {
  calculateBillingUnitAmount,
  planDriverBillingUnits
} from "../../../src/mbt/mbbs-driver-billing-planner.js";
import {
  normalizeMbbsRateCardPolicy
} from "../../../src/mbt/mbbs-rate-card-policy.js";

const COMPLETED_AT = "2026-08-18T22:17:18.674Z";
const V3_POLICY = Object.freeze({
  schemaVersion: 3,
  currency: "CAD",
  directPickupUnitAmountMinor: 10_000,
  poVrmaAdditionalStopUnitAmountMinor: 10_000,
  toReplenishmentAdditionalDropUnitAmountMinor: 12_345,
  soChargeBasis: "per_order_group_as_one",
  toReplenishmentChargeBasis: "full_route_once",
  toDirectPickupChargeBasis: "fixed_unit_once",
  poChargeBasis: "shared_leg_equal_split",
  dispatchLoadSplitBasis: "ignored_for_charge",
  poVrmaBaseChargeBasis: "vendor_yard_pair_then_distance_band",
  vrmaDirectionBasis: "same_pair_reverse",
  poVrmaAdditionalStopBasis: "each_distinct_stop_after_base_pair",
  endpointOverrideBasis: "flat_default_user_may_choose_distance",
  toReplenishmentMultiDropBasis: "longest_origin_drop_plus_each_distinct_drop_after_first"
});

function order(orderRef) {
  return { orderRef, orderType: "TRANSFER_ORDER", source: "delivery" };
}

function stop(id, stopType, address, references, physicalVisitStopIds = [id]) {
  return {
    id,
    stopType,
    orderRefs: references,
    completedAt: COMPLETED_AT,
    details: {
      address,
      orders: references.map(order),
      physicalVisitStopIds
    }
  };
}

function canonical(rootReference, destinationAddress) {
  return {
    sourceType: "TO",
    rootReference,
    originAddress: "Stale NetSuite origin",
    destinationAddress
  };
}

test("over-75 km is base CAD 385 plus CAD 7 only for excess kilometres", () => {
  const band = {
    amountMinor: 700,
    pricingBasis: "per_km",
    baseAmountMinor: 38_500,
    includedMetres: 75_000
  };
  assert.equal(calculateDistanceBandChargeMinor(band, 75_000), 38_500);
  assert.equal(calculateDistanceBandChargeMinor(band, 80_000), 42_000);
  assert.equal(calculateDistanceBandChargeMinor(band, 80_001), 42_001);
});

test("base-plus-excess configuration fails closed when only one paired field is supplied", () => {
  for (const band of [
    { amountMinor: 700, pricingBasis: "per_km", baseAmountMinor: 38_500 },
    { amountMinor: 700, pricingBasis: "per_km", includedMetres: 75_000 }
  ]) {
    assert.throws(
      () => calculateDistanceBandChargeMinor(band, 80_000),
      (error) => error?.code === "MBT_RATE_EXCESS_CONFIGURATION_INVALID"
    );
  }
});

test("database NULL base-plus-excess fields remain valid on historical flat bands", () => {
  assert.equal(calculateDistanceBandChargeMinor({
    amountMinor: 28_500,
    pricingBasis: "flat",
    baseAmountMinor: null,
    includedMetres: null
  }, 42_000), 28_500);
});

test("distance-band boundary and pricing contracts fail closed at every malformed v4 seam", () => {
  assert.equal(normalizedBoundaryRule(undefined), "lower_inclusive");
  assert.equal(normalizedBoundaryRule("upper_inclusive"), "upper_inclusive");
  assert.equal(normalizedDistancePricingBasis(undefined), "flat");
  assert.equal(normalizedDistancePricingBasis("per_km"), "per_km");
  assert.equal(distanceBandContains({ minimumMetres: 30_000, maximumMetres: 50_000 }, 30_000), true);
  assert.equal(distanceBandContains({ minimumMetres: 30_000, maximumMetres: 50_000 }, 50_000), false);
  assert.equal(distanceBandContains({ minimumMetres: 30_000, maximumMetres: 50_000, boundaryRule: "upper_inclusive" }, 30_000), false);
  assert.equal(distanceBandContains({ minimumMetres: 30_000, maximumMetres: 50_000, boundaryRule: "upper_inclusive" }, 50_000), true);
  assert.equal(distanceBandContains({ minimumMetres: 0, maximumMetres: null, boundaryRule: "upper_inclusive" }, 0), true);
  assert.throws(() => normalizedBoundaryRule("overlapping"), (error) => error?.code === "MBT_RATE_BOUNDARY_RULE_INVALID");
  assert.throws(() => normalizedDistancePricingBasis("per_mile"), (error) => error?.code === "MBT_RATE_PRICING_BASIS_INVALID");

  /** @type {Array<[Record<string, any>, number, string]>} */
  const invalidCalculations = [
    [{ amountMinor: 700, pricingBasis: "per_km" }, -1, "MBT_RATE_DISTANCE_INVALID"],
    [{ amountMinor: 700, pricingBasis: "per_km" }, 1.5, "MBT_RATE_DISTANCE_INVALID"],
    [{ amountMinor: -1, pricingBasis: "per_km" }, 80_000, "MBT_RATE_MONEY_INVALID"],
    [{ amountMinor: 1.5, pricingBasis: "per_km" }, 80_000, "MBT_RATE_MONEY_INVALID"],
    [{ amountMinor: 28_500, pricingBasis: "flat", baseAmountMinor: 1, includedMetres: 1 }, 40_000, "MBT_RATE_EXCESS_CONFIGURATION_INVALID"],
    [{ amountMinor: 700, pricingBasis: "per_km", baseAmountMinor: -1, includedMetres: 75_000 }, 80_000, "MBT_RATE_EXCESS_CONFIGURATION_INVALID"],
    [{ amountMinor: 700, pricingBasis: "per_km", baseAmountMinor: 38_500, includedMetres: 1.5 }, 80_000, "MBT_RATE_EXCESS_CONFIGURATION_INVALID"],
    [{ amountMinor: Number.MAX_SAFE_INTEGER, pricingBasis: "per_km" }, 2_000, "MBT_RATE_MONEY_OVERFLOW"]
  ];
  for (const [band, metres, code] of invalidCalculations) {
    assert.throws(
      () => calculateDistanceBandChargeMinor(band, metres),
      (error) => error?.code === code
    );
  }
});

test("same immutable load and physical TO pickup becomes one auditable longest-drop unit", () => {
  const references = ["TOB00888-S1", "TOB00907", "TOB00903"];
  const units = planDriverBillingUnits({
    planId: "238",
    planDate: "2026-08-18",
    loadId: "T3-L1787064784054-6890cd7d90cec",
    loadName: "Load 3",
    completedAt: COMPLETED_AT,
    records: [
      stop("pickup-150", "pickup", "150 Clark Blvd, Brampton, ON", references),
      stop("drop-2967", "dropoff", "2967 Kennedy Road, Toronto, ON", [references[0]]),
      stop("drop-3445", "dropoff", "3445 Kennedy Road, Toronto, ON", [references[1]]),
      stop("drop-12441", "dropoff", "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", [references[2]])
    ],
    canonicalOrders: [
      canonical(references[0], "2967 Kennedy Road, Toronto, ON"),
      canonical(references[1], "3445 Kennedy Road, Toronto, ON"),
      canonical(references[2], "12441 Woodbine Avenue, Whitchurch-Stouffville, ON")
    ]
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].billingRule, "to_replenishment_multi_drop");
  assert.equal(units[0].distanceStrategy, "longest_origin_to_drop");
  assert.deepEqual(
    units[0].references.map((reference) => reference.rootReference),
    references
  );
  assert.deepEqual(units[0].routeStops.map((entry) => entry.addressText), [
    "150 Clark Blvd, Brampton, ON",
    "2967 Kennedy Road, Toronto, ON",
    "3445 Kennedy Road, Toronto, ON",
    "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
  ]);
  assert.equal(units[0].dropCount, 3);
  assert.deepEqual(units[0].driverLoadIds, ["T3-L1787064784054-6890cd7d90cec"]);
});

test("separate physical pickups and separate immutable loads never merge TO charges", () => {
  const sameLoad = planDriverBillingUnits({
    planId: "239",
    planDate: "2026-08-19",
    loadId: "ONE-IMMUTABLE-LOAD",
    loadName: "Load 1",
    completedAt: COMPLETED_AT,
    records: [
      stop("pickup-a", "pickup", "150 Clark Blvd", ["TO-A"]),
      stop("drop-a", "dropoff", "2967 Kennedy Road", ["TO-A"]),
      stop("pickup-b", "pickup", "150 Clark Blvd", ["TO-B"]),
      stop("drop-b", "dropoff", "3445 Kennedy Road", ["TO-B"])
    ]
  });
  assert.equal(sameLoad.length, 2, "two physical pickup visits in one load are two legs");

  const separateLoads = planDriverBillingUnits({
    planId: "240",
    planDate: "2026-08-20",
    loads: ["DRIVER-A", "DRIVER-B"].map((loadId, index) => ({
      loadId,
      loadName: "Load 1",
      completedAt: COMPLETED_AT,
      records: [
        stop(`${loadId}-pickup`, "pickup", "150 Clark Blvd", [`TO-${index}`]),
        stop(`${loadId}-drop`, "dropoff", "2967 Kennedy Road", [`TO-${index}`])
      ]
    }))
  });
  assert.equal(separateLoads.length, 2);
  assert.equal(new Set(separateLoads.map((unit) => unit.unitKey)).size, 2);
});

test("actual retained pickup address wins over stale canonical origin", () => {
  const [unit] = planDriverBillingUnits({
    planId: "241",
    planDate: "2026-08-20",
    loadId: "OVERRIDE-LOAD",
    loadName: "Load 4",
    completedAt: COMPLETED_AT,
    records: [
      stop("override-pickup", "pickup", "Dispatcher override origin", ["TO-OVERRIDE"]),
      stop("override-drop", "dropoff", "Actual destination", ["TO-OVERRIDE"])
    ],
    canonicalOrders: [canonical("TO-OVERRIDE", "Canonical destination")]
  });
  assert.equal(unit.originLabel, "Dispatcher override origin");
  assert.deepEqual(unit.routeStops.map((entry) => entry.addressText), [
    "Dispatcher override origin",
    "Actual destination"
  ]);
});

test("actual retained pickup also wins for a direct-pickup TO", () => {
  const pickup = stop("direct-override-pickup", "pickup", "Direct Dispatch override origin", ["TO-DIRECT-OVERRIDE"]);
  const drop = stop("direct-override-drop", "dropoff", "Direct actual destination", ["TO-DIRECT-OVERRIDE"]);
  pickup.details.orders[0].source = "direct_dependency";
  drop.details.orders[0].source = "direct_dependency";
  const [unit] = planDriverBillingUnits({
    planId: "242",
    planDate: "2026-08-20",
    loadId: "DIRECT-OVERRIDE-LOAD",
    loadName: "Load 5",
    completedAt: COMPLETED_AT,
    records: [pickup, drop],
    canonicalOrders: [canonical("TO-DIRECT-OVERRIDE", "Canonical direct destination")]
  });
  assert.equal(unit.billingRule, "to_direct_additional_drop");
  assert.equal(unit.originLabel, "Direct Dispatch override origin");
  assert.deepEqual(unit.routeStops.map((entry) => entry.addressText), [
    "Direct Dispatch override origin",
    "Direct actual destination"
  ]);
});

test("explicit Dispatch endpoints win stale Driver evidence for a direct-pickup TO", () => {
  const pickup = stop("direct-explicit-pickup", "pickup", "Stale Driver pickup", ["TO-DIRECT-EXPLICIT"]);
  const drop = stop("direct-explicit-drop", "dropoff", "Stale Driver delivery", ["TO-DIRECT-EXPLICIT"]);
  pickup.details.orders[0].source = "direct_dependency";
  drop.details.orders[0].source = "direct_dependency";
  const [unit] = planDriverBillingUnits({
    planId: "243",
    planDate: "2026-08-20",
    loadId: "DIRECT-EXPLICIT-LOAD",
    loadName: "Load 6",
    completedAt: COMPLETED_AT,
    records: [pickup, drop],
    canonicalOrders: [{
      ...canonical("TO-DIRECT-EXPLICIT", "Canonical direct destination"),
      originAddressOverride: "Explicit Dispatch pickup",
      destinationAddressOverride: "Explicit Dispatch delivery"
    }]
  });
  assert.equal(unit.billingRule, "to_direct_additional_drop");
  assert.deepEqual(unit.routeStops.map((entry) => entry.addressText), [
    "Explicit Dispatch pickup",
    "Explicit Dispatch delivery"
  ]);
});

test("v3 rate-card policy exposes the replenishment TO multi-drop unit price", () => {
  assert.deepEqual(normalizeMbbsRateCardPolicy(structuredClone(V3_POLICY)), V3_POLICY);
  assert.deepEqual(calculateBillingUnitAmount({
    billingRule: "to_replenishment_multi_drop",
    distanceBandAmountMinor: 33_500,
    dropCount: 3,
    mbbsChargingPolicy: V3_POLICY
  }), {
    distanceBandAmountMinor: 33_500,
    additionalDropCount: 2,
    additionalDropUnitAmountMinor: 12_345,
    additionalDropFeeMinor: 24_690,
    calculatedAmountMinor: 58_190
  });
});

test("conversion allocates one multi-drop TO charge instead of duplicating it per order", () => {
  const totalMinor = 53_500;
  const result = calculateMbbsCrossCharges({
    currency: "CAD",
    loads: [{
      physicalLoadId: "T3-L1787064784054-6890cd7d90cec:pickup-150",
      completedAt: COMPLETED_AT,
      planDate: "2026-08-18",
      calculatedMetres: 64_000,
      sharedTotalMinor: totalMinor,
      billingEvidence: { billingRule: "to_replenishment_multi_drop" },
      references: ["TOB00888-S1", "TOB00907", "TOB00903"].map((rootReference) => ({
        sourceType: "TO",
        rootReference
      }))
    }]
  });

  assert.equal(result.cases.length, 3);
  assert.equal(result.allocationGroups.length, 1);
  assert.equal(
    result.cases.reduce((sum, entry) => sum + entry.allocatedAmountMinor, 0),
    totalMinor
  );
  assert.ok(result.cases.every((entry) => entry.allocationKey?.startsWith("TO_MULTI_DROP|")));
  assert.deepEqual(result.cases.map((entry) => entry.allocatedAmountMinor), [17_833, 17_833, 17_834]);
});

test("Billing and Rate Card UIs expose endpoint edits and the visible TO multi-drop rule", async () => {
  const [billingHtml, billingClient, configHtml, configClient, candidateService, migration] = await Promise.all([
    readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
    readFile(new URL("../../../public/mbt-billing.js", import.meta.url), "utf8"),
    readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
    readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
    readFile(new URL("../../../src/mbt/mbbs-billing-candidate-service.js", import.meta.url), "utf8"),
    readFile(new URL("../../../migrations/175_mbt_mbbs_cross_charge_route_pricing_v4.sql", import.meta.url), "utf8")
  ]);
  assert.match(billingHtml, /id="mbbsBillingOriginText"/u);
  assert.match(billingHtml, /id="mbbsBillingDestinationText"/u);
  assert.match(billingClient, /originAddressText/u);
  assert.match(billingClient, /destinationAddressText/u);
  assert.match(configHtml, /id="mbbsToAdditionalDropUnitPrice"/u);
  assert.match(configHtml, /longest.*origin.*drop/iu);
  assert.match(configClient, /toReplenishmentAdditionalDropUnitAmountMinor/u);
  assert.match(candidateService, /distanceStrategy:\s*text\(unit\.distanceStrategy\)/u);
  assert.match(migration, /base_amount_minor/iu);
  assert.match(migration, /included_metres/iu);
  assert.match(migration, /origin_address_text/iu);
  assert.match(migration, /version_number[^;]*4/isu);
});

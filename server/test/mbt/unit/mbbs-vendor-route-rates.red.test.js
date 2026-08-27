// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  MBBS_PO_VRMA_RATE_SEED,
  calculateMbbsPurchaseRouteAmount,
  normalizeMbbsVendorRouteRates,
  planMbbsPoVrmaRateSeed,
  selectMbbsVendorRouteRate
} from "../../../src/mbt/mbbs-vendor-route-rates.js";
import {
  DEFAULT_MBBS_RATE_CARD_POLICY,
  DEFAULT_MBBS_RATE_CARD_POLICY_V3,
  normalizeMbbsRateCardPolicy
} from "../../../src/mbt/mbbs-rate-card-policy.js";

const V2_POLICY = Object.freeze({
  schemaVersion: 2,
  currency: "CAD",
  poVrmaAdditionalStopUnitAmountMinor: 10_000
});

const LATEST_SUPPLIED_PO_VRMA_TABLE = `
Beaver Valley Stone - Maple to 12441|200
Beaver Valley Stone - Maple to 2967|250
Beaver Valley Stone - Maple to 3445|250
Beaver Valley Stone - Maple to 150|300
Bestway Stone - Uxbridge to 12441|200
Bestway Stone - Uxbridge to 2967|250
Bestway Stone - Uxbridge to 3445|250
Bestway Stone - Uxbridge to 150|450
Bestway Stone -Woodbridge to 12441|350
Bestway Stone -Woodbridge to 2967|350
Bestway Stone -Woodbridge to 3445|350
Bestway Stone -Woodbridge to 150|400
Browns - Sudbury to 12441|1550
Browns - Sudbury to 2967|1650
Browns - Sudbury to 3445|1650
Browns - Sudbury to 150|1700
Canada Fasting to 2967|350
Canada Fasting to 3445|350
Crupi - Markham to 2967|150
Crupi - Markham to 3445|150
Crupi - Scarborough to 2967|150
Crupi - Scarborough to 3445|150
Draglam - Vaughan to 2967|300
Draglam - Vaughan to 3445|300
Oakville Stone - Mississaga to 12441|350
Oakville Stone - Mississaga to 2967|450
Oakville Stone - Mississaga to 3445|450
Oakville Stone - Mississaga to 150|400
Permacon - Bolton to 12441|350
Permacon - Bolton to 2967|450
Permacon - Bolton to 3445|450
Permacon - Bolton to 150|450
Permacon - Cambridge to 12441|550
Permacon - Cambridge to 2967|600
Permacon - Cambridge to 3445|600
Permacon - Cambridge to 150|550
Permacon - Milton to 12441|450
Permacon - Milton to 2967|500
Permacon - Milton to 3445|500
Permacon - Milton to 150|500
Permacon - Woodstock to 2967|700
Permacon - Woodstock to 3445|700
Techo - AYR to 12441|550
Techo - AYR to 2967|600
Techo - AYR to 3445|600
Techo - AYR to 150|550
Techo - VAUGHAN to 12441|300
Techo - VAUGHAN to 2967|350
Techo - VAUGHAN to 3445|350
Techo - VAUGHAN to 150|400
Unilock - Ayr to 12441|550
Unilock - Ayr to 2967|600
Unilock - Ayr to 3445|600
Unilock - Ayr to 150|550
Unilock - Barrie to 2967|450
Unilock - Barrie to 3445|450
Unilock - Georgetown to 12441|450
Unilock - Georgetown to 2967|450
Unilock - Georgetown to 3445|450
Unilock - Georgetown to 150|400
Unilock - Gormly to 2967|250
Unilock - Gormly to 3445|250
Unilock - Gormly to 150|400
Unilock - Pickering to 12441|300
Unilock - Pickering to 2967|300
Unilock - Pickering to 3445|300
Unilock - Pickering to 150|500
Unilock- Gormly to 12441|150
Voyage - Scarborough to 12441|250
Voyage - Scarborough to 2967|250
Voyage - Scarborough to 3445|250
`.trim().split("\n").map((line) => {
  const [name, dollars] = line.split("|");
  return { rateName: name, displayName: name, baseAmountMinor: Number(dollars) * 100 };
});

test("M1 policy schema v2 makes vendor-pair, reverse VRMA, fallback, override, and extra-stop rules explicit", () => {
  assert.deepEqual(normalizeMbbsRateCardPolicy({
    schemaVersion: 2,
    currency: "CAD",
    directPickupUnitAmountMinor: 10_000,
    poVrmaAdditionalStopUnitAmountMinor: 12_345,
    soChargeBasis: "per_order_group_as_one",
    toReplenishmentChargeBasis: "full_route_once",
    toDirectPickupChargeBasis: "fixed_unit_once",
    poChargeBasis: "shared_leg_equal_split",
    dispatchLoadSplitBasis: "ignored_for_charge",
    poVrmaBaseChargeBasis: "vendor_yard_pair_then_distance_band",
    vrmaDirectionBasis: "same_pair_reverse",
    poVrmaAdditionalStopBasis: "each_distinct_stop_after_base_pair",
    endpointOverrideBasis: "flat_default_user_may_choose_distance"
  }), {
    schemaVersion: 2,
    currency: "CAD",
    directPickupUnitAmountMinor: 10_000,
    poVrmaAdditionalStopUnitAmountMinor: 12_345,
    soChargeBasis: "per_order_group_as_one",
    toReplenishmentChargeBasis: "full_route_once",
    toDirectPickupChargeBasis: "fixed_unit_once",
    poChargeBasis: "shared_leg_equal_split",
    dispatchLoadSplitBasis: "ignored_for_charge",
    poVrmaBaseChargeBasis: "vendor_yard_pair_then_distance_band",
    vrmaDirectionBasis: "same_pair_reverse",
    poVrmaAdditionalStopBasis: "each_distinct_stop_after_base_pair",
    endpointOverrideBasis: "flat_default_user_may_choose_distance"
  });
  assert.deepEqual(normalizeMbbsRateCardPolicy(DEFAULT_MBBS_RATE_CARD_POLICY), DEFAULT_MBBS_RATE_CARD_POLICY);
});

test("M9 canonical seed exactly matches every name, display name, and CAD amount in the latest 71-row table", () => {
  const byRateName = (rows) => [...rows].sort((left, right) => left.rateName.localeCompare(right.rateName));
  assert.deepEqual(
    byRateName(MBBS_PO_VRMA_RATE_SEED.map(({ rateName, displayName, baseAmountMinor }) => ({
      rateName,
      displayName,
      baseAmountMinor
    }))),
    byRateName(LATEST_SUPPLIED_PO_VRMA_TABLE)
  );
});

function rate(overrides = {}) {
  return {
    rateName: "Bestway Stone - Uxbridge to 12441",
    displayName: "Bestway Stone - Uxbridge to 12441",
    localVendorId: 6,
    localVendorName: "BWS",
    vendorYardName: "BWS Uxbridge",
    vendorYardAddress: "65 Anderson Blvd, Uxbridge, ON L9P 0C7",
    destinationYardCode: "12441",
    baseAmountMinor: 20_000,
    currency: "CAD",
    ...overrides
  };
}

test("M1 schema-v2 vendor-route rows normalize deterministically and reject unsafe or duplicate money", () => {
  const normalized = normalizeMbbsVendorRouteRates([
    rate({ destinationYardCode: "3445", baseAmountMinor: 25_000 }),
    rate()
  ]);
  assert.deepEqual(normalized.map((row) => [row.destinationYardCode, row.baseAmountMinor]), [
    ["12441", 20_000],
    ["3445", 25_000]
  ]);
  assert.throws(
    () => normalizeMbbsVendorRouteRates([rate(), rate({ displayName: "duplicate" })]),
    (error) => error?.code === "MBT_VENDOR_ROUTE_RATE_DUPLICATE"
  );
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "20000"]) {
    assert.throws(
      () => normalizeMbbsVendorRouteRates([rate({ baseAmountMinor: invalid })]),
      (error) => error?.code === "MBT_VENDOR_ROUTE_RATE_INVALID"
    );
  }
});

test("M2 PO and reverse VRMA select the same exact configured yard pair without fuzzy matching", () => {
  const rates = normalizeMbbsVendorRouteRates([rate()]);
  for (const sourceType of ["PO", "VRMA"]) {
    const selected = selectMbbsVendorRouteRate(rates, {
      sourceType,
      localVendorId: 6,
      vendorYardName: " bws uxbridge ",
      vendorYardAliases: ["Uxbridge"],
      mbbsYardCode: "12441"
    });
    assert.equal(selected?.baseAmountMinor, 20_000);
    assert.equal(selected?.pricingSource, "vendor_yard_flat");
  }
  assert.equal(selectMbbsVendorRouteRate(rates, {
    sourceType: "PO",
    localVendorId: 6,
    vendorYardName: "BWS Ux",
    vendorYardAliases: [],
    mbbsYardCode: "12441"
  }), null);
  assert.equal(selectMbbsVendorRouteRate(rates, {
    sourceType: "SO",
    localVendorId: 6,
    vendorYardName: "BWS Uxbridge",
    vendorYardAliases: [],
    mbbsYardCode: "12441"
  }), null);
});

test("M3-M4 flat or distance base is charged once, extra stops are versioned, and overflow fails closed", () => {
  assert.deepEqual(calculateMbbsPurchaseRouteAmount({
    pricingMethod: "vendor_yard_flat",
    vendorRouteAmountMinor: 25_000,
    distanceBandAmountMinor: 90_000,
    routeStopCount: 3,
    mbbsChargingPolicy: V2_POLICY
  }), {
    pricingMethod: "vendor_yard_flat",
    pricingSource: "vendor_yard_flat",
    baseAmountMinor: 25_000,
    distanceBandAmountMinor: 0,
    vendorRouteAmountMinor: 25_000,
    additionalStopCount: 1,
    additionalStopUnitAmountMinor: 10_000,
    additionalStopFeeMinor: 10_000,
    calculatedAmountMinor: 35_000
  });
  assert.equal(calculateMbbsPurchaseRouteAmount({
    pricingMethod: "distance_band",
    vendorRouteAmountMinor: 25_000,
    distanceBandAmountMinor: 90_000,
    routeStopCount: 4,
    mbbsChargingPolicy: V2_POLICY
  }).calculatedAmountMinor, 110_000);
  assert.throws(
    () => calculateMbbsPurchaseRouteAmount({
      pricingMethod: "vendor_yard_flat",
      vendorRouteAmountMinor: Number.MAX_SAFE_INTEGER,
      distanceBandAmountMinor: 0,
      routeStopCount: 3,
      mbbsChargingPolicy: V2_POLICY
    }),
    (error) => error?.code === "MBT_BILLING_AMOUNT_INVALID"
  );
});

test("v4 schema-v3 prices BWS Uxbridge to 12441 at exactly CAD 200 and retains fail-closed policy validation", () => {
  assert.deepEqual(calculateMbbsPurchaseRouteAmount({
    pricingMethod: "vendor_yard_flat",
    vendorRouteAmountMinor: 20_000,
    distanceBandAmountMinor: 0,
    routeStopCount: 2,
    mbbsChargingPolicy: DEFAULT_MBBS_RATE_CARD_POLICY_V3
  }), {
    pricingMethod: "vendor_yard_flat",
    pricingSource: "vendor_yard_flat",
    baseAmountMinor: 20_000,
    distanceBandAmountMinor: 0,
    vendorRouteAmountMinor: 20_000,
    additionalStopCount: 0,
    additionalStopUnitAmountMinor: 10_000,
    additionalStopFeeMinor: 0,
    calculatedAmountMinor: 20_000
  });

  for (const mbbsChargingPolicy of [
    { ...DEFAULT_MBBS_RATE_CARD_POLICY_V3, schemaVersion: 1 },
    { ...DEFAULT_MBBS_RATE_CARD_POLICY_V3, schemaVersion: 4 },
    { ...DEFAULT_MBBS_RATE_CARD_POLICY_V3, currency: "USD" }
  ]) {
    assert.throws(
      () => calculateMbbsPurchaseRouteAmount({
        pricingMethod: "vendor_yard_flat",
        vendorRouteAmountMinor: 20_000,
        distanceBandAmountMinor: 0,
        routeStopCount: 2,
        mbbsChargingPolicy
      }),
      (error) => error?.code === "MBT_RATE_CARD_POLICY_INVALID"
    );
  }
});

test("M7-M9 latest supplied table resolves 54 exact rows with canonical 150 labels and 17 distance fallbacks", () => {
  assert.equal(MBBS_PO_VRMA_RATE_SEED.length, 71);
  const vendorYards = [
    [13, "Beaver Valley Stone", "Beaver Valley Stone", "12350 Keele St, Maple, ON L6A 2C4"],
    [6, "BWS", "BWS Uxbridge", "65 Anderson Blvd, Uxbridge, ON L9P 0C7"],
    [6, "BWS", "BWS Woodbridge", "8821 Weston Rd, Woodbridge, ON L4L 1A6"],
    [14, "CFC", "CFC", "5115 Satellite Dr, Mississauga, ON L4W 5B6"],
    [12, "Oakville", "Oakville Stone", "960 Kamato Rd, Mississauga, ON L4W 2R6"],
    [7, "PERMACON", "PERMACON Bolton", "3 Betomat Ct. Bolton, ON L7E 2V9"],
    [7, "PERMACON", "PERMACON Cambridge", "1081 Rife Rd, Cambridge, ON N1R 5S3"],
    [7, "PERMACON", "PERMACON Milton", "8375 5 Side Rd, Milton, ON L7J 0A1"],
    [10, "Techo-Bloc", "TECHO BLOC Ayr", "2852 Cedar Creek Rd, Ayr, ON N0B 1E0"],
    [10, "Techo-Bloc", "TECHO BLOC Vaughan", "720 Arrow Rd. North York, ON M9M 2M1"],
    [4, "Unilock Ltd", "Ayr Yard - Unilock", "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0"],
    [4, "Unilock Ltd", "UNILOCK Georgetown", "287 Armstrong Ave, Georgetown, ON L7G 4X6"],
    [4, "Unilock Ltd", "UNILOCK Gormley", "37 Gormley Rd E, Gormley, ON L0H 1G0"],
    [4, "Unilock Ltd", "UNILOCK Pickering", "1890 Clements Rd, Pickering, ON L1W 3R8"]
  ].map(([localVendorId, localVendorName, vendorYardName, vendorYardAddress]) => ({
    localVendorId,
    localVendorName,
    vendorYardName,
    vendorYardAddress,
    aliases: []
  }));
  const planned = planMbbsPoVrmaRateSeed({
    vendorYards,
    mbbsYards: ["12441", "150", "2967", "3445"]
  });
  assert.equal(planned.mapped.length, 54);
  assert.equal(planned.fallback.length, 17);
  assert.equal(MBBS_PO_VRMA_RATE_SEED.some((row) => / to BS$/u.test(row.rateName)), false);
  assert.equal(MBBS_PO_VRMA_RATE_SEED.some((row) => / to BS$/u.test(row.displayName)), false);
  assert.equal(planned.mapped.find((row) => row.rateName === "Permacon - Cambridge to 150")?.destinationYardCode, "150");
  assert.equal(planned.mapped.find((row) => row.rateName === "Permacon - Cambridge to 150")?.baseAmountMinor, 55_000);
  assert.equal(planned.mapped.find((row) => row.rateName === "Unilock - Georgetown to 150")?.destinationYardCode, "150");
  assert.equal(planned.mapped.find((row) => row.rateName === "Unilock - Georgetown to 150")?.baseAmountMinor, 40_000);
  assert.equal(planned.mapped.find((row) => row.rateName === "Unilock- Gormly to 12441")?.baseAmountMinor, 15_000);
  assert.equal(planned.mapped.find((row) => row.rateName === "Canada Fasting to 2967")?.localVendorName, "CFC");
  assert.deepEqual(
    [...new Set(planned.fallback.map((row) => row.originKey))].sort(),
    [
      "browns_sudbury",
      "crupi_markham",
      "crupi_scarborough",
      "draglam_vaughan",
      "permacon_woodstock",
      "unilock_barrie",
      "voyage_scarborough"
    ]
  );
});

test("M1-M4 hostile malformed identities, matrix rows, policies, route counts, and unsafe cents fail closed", () => {
  for (const invalidRates of [null, Array.from({ length: 2_001 }, () => rate())]) {
    assert.throws(
      () => normalizeMbbsVendorRouteRates(invalidRates),
      (error) => error?.code === "MBT_VENDOR_ROUTE_RATE_INVALID"
    );
  }
  for (const invalidRow of [
    null,
    [],
    rate({ unsupported: true }),
    rate({ currency: "USD" }),
    rate({ rateName: "" }),
    rate({ localVendorId: 0 })
  ]) {
    assert.throws(
      () => normalizeMbbsVendorRouteRates([invalidRow]),
      (error) => error?.code === "MBT_VENDOR_ROUTE_RATE_INVALID"
    );
  }

  const rates = [rate()];
  for (const identity of [null, [], { sourceType: "PO", localVendorId: 0 }]) {
    assert.equal(selectMbbsVendorRouteRate(rates, identity), null);
  }
  assert.equal(selectMbbsVendorRouteRate(rates, {
    sourceType: "PO",
    localVendorId: 6,
    vendorYardName: "",
    mbbsYardCode: "12441"
  }), null);

  const valid = {
    pricingMethod: "vendor_yard_flat",
    vendorRouteAmountMinor: 1,
    distanceBandAmountMinor: 0,
    routeStopCount: 2,
    mbbsChargingPolicy: V2_POLICY
  };
  for (const [input, code] of [
    [null, "MBT_RATE_CARD_POLICY_INVALID"],
    [{ ...valid, mbbsChargingPolicy: null }, "MBT_RATE_CARD_POLICY_INVALID"],
    [{ ...valid, pricingMethod: "hidden_default" }, "MBT_VENDOR_ROUTE_PRICING_METHOD_INVALID"],
    [{ ...valid, routeStopCount: 1 }, "MBT_VENDOR_ROUTE_RATE_INVALID"],
    [{ ...valid, distanceBandAmountMinor: -1 }, "MBT_VENDOR_ROUTE_RATE_INVALID"],
    [{ ...valid, vendorRouteAmountMinor: -1 }, "MBT_VENDOR_ROUTE_RATE_INVALID"],
    [{ ...valid, mbbsChargingPolicy: policyWithAdditionalStop(-1) }, "MBT_VENDOR_ROUTE_RATE_INVALID"],
    [{ ...valid, routeStopCount: 4, mbbsChargingPolicy: policyWithAdditionalStop(Number.MAX_SAFE_INTEGER) }, "MBT_BILLING_AMOUNT_INVALID"]
  ]) {
    assert.throws(
      () => calculateMbbsPurchaseRouteAmount(input),
      (error) => error?.code === code
    );
  }
  assert.throws(
    () => calculateMbbsPurchaseRouteAmount({
      ...valid,
      vendorRouteAmountMinor: Number.MAX_SAFE_INTEGER,
      routeStopCount: 3,
      mbbsChargingPolicy: policyWithAdditionalStop(1)
    }),
    (error) => error?.code === "MBT_BILLING_AMOUNT_INVALID"
  );

  for (const input of [null, {}, { vendorYards: "not-a-list", mbbsYards: "not-a-list" }]) {
    const seed = planMbbsPoVrmaRateSeed(input);
    assert.equal(seed.mapped.length, 0);
    assert.equal(seed.fallback.length, 71);
  }
});

/** @param {number} amountMinor */
function policyWithAdditionalStop(amountMinor) {
  return { ...V2_POLICY, poVrmaAdditionalStopUnitAmountMinor: amountMinor };
}

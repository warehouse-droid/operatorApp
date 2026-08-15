// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateBillingUnitAmount } from "../../../src/mbt/mbbs-driver-billing-planner.js";

const policyModule = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/mbbs-rate-card-policy.js"
).catch(() => ({})));

const [html, client, migration] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/160_mbt_mbbs_rate_card_charging_policy.sql", import.meta.url), "utf8")
    .catch(() => "")
]);

const POLICY = Object.freeze({
  schemaVersion: 1,
  currency: "CAD",
  directPickupUnitAmountMinor: 12_345,
  poAdditionalDropUnitAmountMinor: 4_567,
  soChargeBasis: "per_order_group_as_one",
  toReplenishmentChargeBasis: "full_route_once",
  toDirectPickupChargeBasis: "fixed_unit_once",
  poChargeBasis: "shared_leg_equal_split",
  poAdditionalDropBasis: "each_distinct_drop_after_first",
  dispatchLoadSplitBasis: "ignored_for_charge"
});

test("P2: policy normalization retains exact configurable CAD unit prices", () => {
  const normalize = policyModule.normalizeMbbsRateCardPolicy;
  assert.equal(typeof normalize, "function", "A pure MBBS rate-card policy normalizer is required.");
  assert.deepEqual(normalize(structuredClone(POLICY)), POLICY);
});

test("P2: invalid or hostile unit prices fail closed", () => {
  const normalize = policyModule.normalizeMbbsRateCardPolicy;
  assert.equal(typeof normalize, "function", "A pure MBBS rate-card policy normalizer is required.");
  for (const invalidShape of [null, [], "not-a-policy"]) {
    assert.throws(
      () => normalize(invalidShape),
      (error) => error?.code === "MBT_RATE_CARD_POLICY_INVALID"
    );
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "10000"]) {
    assert.throws(
      () => normalize({ ...POLICY, directPickupUnitAmountMinor: invalid }),
      (error) => error?.code === "MBT_RATE_CARD_POLICY_INVALID"
    );
    assert.throws(
      () => normalize({ ...POLICY, poAdditionalDropUnitAmountMinor: invalid }),
      (error) => error?.code === "MBT_RATE_CARD_POLICY_INVALID"
    );
  }
  for (const hostile of [
    { ...POLICY, schemaVersion: 2 },
    { ...POLICY, currency: "USD" },
    { ...POLICY, soChargeBasis: "per_load" },
    { ...POLICY, unsupportedRule: true }
  ]) {
    assert.throws(
      () => normalize(hostile),
      (error) => error?.code === "MBT_RATE_CARD_POLICY_INVALID"
    );
  }
});

test("P3: only an exact MBBS cross-charge band owns this policy", () => {
  const ownsPolicy = policyModule.isMbbsCrossChargeGraph;
  assert.equal(typeof ownsPolicy, "function");
  for (const invalidShape of [null, [], "not-a-graph", {}]) {
    assert.equal(ownsPolicy(invalidShape), false);
  }
  assert.equal(ownsPolicy({
    distanceBands: [{
      itemCode: "DELIVERY_CHARGE_MBBS",
      serviceCode: "mbbs_cross_charge"
    }]
  }), true);
  assert.equal(ownsPolicy({
    distanceBands: [{
      itemCode: "DELIVERY_CHARGE_MBBS",
      serviceCode: "delivery"
    }]
  }), false);
});

test("P5: direct-pickup TO uses the selected rate card's unit price and no distance amount", () => {
  assert.deepEqual(calculateBillingUnitAmount({
    billingRule: "to_direct_additional_drop",
    distanceBandAmountMinor: 88_800,
    dropCount: 1,
    mbbsChargingPolicy: POLICY
  }), {
    distanceBandAmountMinor: 0,
    additionalDropCount: 1,
    additionalDropUnitAmountMinor: 12_345,
    additionalDropFeeMinor: 12_345,
    calculatedAmountMinor: 12_345
  });
});

test("P6: PO uses its own additional-drop unit price for each distinct drop after the first", () => {
  assert.deepEqual(calculateBillingUnitAmount({
    billingRule: "po_shared_leg",
    distanceBandAmountMinor: 20_000,
    dropCount: 3,
    mbbsChargingPolicy: POLICY
  }), {
    distanceBandAmountMinor: 20_000,
    additionalDropCount: 2,
    additionalDropUnitAmountMinor: 4_567,
    additionalDropFeeMinor: 9_134,
    calculatedAmountMinor: 29_134
  });
});

test("P7: billing calculation rejects a missing policy instead of using a hidden default", () => {
  assert.throws(
    () => calculateBillingUnitAmount({
      billingRule: "to_direct_additional_drop",
      distanceBandAmountMinor: 20_000,
      dropCount: 1
    }),
    (error) => error?.code === "MBT_RATE_CARD_POLICY_REQUIRED"
  );
});

test("P1/P2: Rate Cards UI visibly explains all charging rules and exposes both draft prices", () => {
  for (const id of [
    "mbbsChargingPolicy",
    "mbbsDirectPickupUnitPrice",
    "mbbsPoAdditionalDropUnitPrice"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
  }
  for (const phrase of [
    /MBBS Charging Policy/iu,
    /Sales Order/iu,
    /Transfer Order/iu,
    /Purchase Order/iu,
    /group.*one charge/iu,
    /load splits do not change/iu,
    /allocated evenly/iu,
    /each distinct drop after the first/iu
  ]) {
    assert.match(html, phrase);
  }
  assert.match(client, /directPickupUnitAmountMinor/u);
  assert.match(client, /poAdditionalDropUnitAmountMinor/u);
  assert.match(client, /mbbsChargingPolicy/u);
  assert.match(client, /inputValue\("mbbsDirectPickupUnitPrice"\)/u);
  assert.match(client, /inputValue\("mbbsPoAdditionalDropUnitPrice"\)/u);
  assert.match(client, /Number\.MAX_SAFE_INTEGER/u);
});

test("P3/P8: migration stores one immutable, version-owned policy and backfills CAD 100.00", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS mbt_mbbs_rate_card_policies/iu);
  assert.match(migration, /rate_card_version_id uuid PRIMARY KEY/iu);
  assert.match(migration, /direct_pickup_unit_amount_minor bigint NOT NULL DEFAULT 10000/iu);
  assert.match(migration, /po_additional_drop_unit_amount_minor bigint NOT NULL DEFAULT 10000/iu);
  assert.match(migration, /INSERT INTO mbt_mbbs_rate_card_policies/iu);
  assert.match(migration, /ON CONFLICT \(rate_card_version_id\) DO NOTHING/iu);
  assert.match(migration, /ignored_for_charge/iu);
  assert.match(migration, /CREATE TRIGGER trg_mbt_mbbs_rate_card_policy_immutable/iu);
});

// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { calculateBillingUnitAmount } from "../../../src/mbt/mbbs-driver-billing-planner.js";
import { MBBS_RATE_CARD_POLICY_RULES } from "../../../src/mbt/mbbs-rate-card-policy.js";

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function policy(directPickupUnitAmountMinor, poAdditionalDropUnitAmountMinor) {
  return {
    schemaVersion: 1,
    currency: "CAD",
    directPickupUnitAmountMinor,
    poAdditionalDropUnitAmountMinor,
    ...MBBS_RATE_CARD_POLICY_RULES
  };
}

test("1,000 generated direct-pickup TO cases charge exactly one selected unit and zero distance", () => {
  const random = generator(0x4d425453);
  for (let index = 0; index < 1_000; index += 1) {
    const directPrice = random() % 10_000_001;
    const poPrice = random() % 10_000_001;
    const rateAmount = random() % 10_000_001;
    const result = calculateBillingUnitAmount({
      billingRule: "to_direct_additional_drop",
      distanceBandAmountMinor: rateAmount,
      dropCount: 1 + (random() % 20),
      mbbsChargingPolicy: policy(directPrice, poPrice)
    });
    assert.deepEqual(result, {
      distanceBandAmountMinor: 0,
      additionalDropCount: 1,
      additionalDropUnitAmountMinor: directPrice,
      additionalDropFeeMinor: directPrice,
      calculatedAmountMinor: directPrice
    });
  }
});

test("1,000 generated PO cases use each distinct drop after the first with exact integer cents", () => {
  const random = generator(0x504f4452);
  for (let index = 0; index < 1_000; index += 1) {
    const directPrice = random() % 1_000_001;
    const poPrice = random() % 1_000_001;
    const rateAmount = random() % 10_000_001;
    const dropCount = 1 + (random() % 50);
    const expectedFee = poPrice * (dropCount - 1);
    for (const billingRule of ["po_shared_leg", "po_group"]) {
      const result = calculateBillingUnitAmount({
        billingRule,
        distanceBandAmountMinor: rateAmount,
        dropCount,
        mbbsChargingPolicy: policy(directPrice, poPrice)
      });
      assert.equal(result.distanceBandAmountMinor, rateAmount);
      assert.equal(result.additionalDropCount, dropCount - 1);
      assert.equal(result.additionalDropUnitAmountMinor, poPrice);
      assert.equal(result.additionalDropFeeMinor, expectedFee);
      assert.equal(result.calculatedAmountMinor, rateAmount + expectedFee);
      assert.ok(Number.isSafeInteger(result.calculatedAmountMinor));
    }
  }
});

test("all non-direct SO/TO/custom rules ignore both configurable unit prices", () => {
  const random = generator(0x534f544f);
  const rules = ["so_order", "so_group", "to_replenishment", "custom_order", "reconciliation"];
  for (let index = 0; index < 1_000; index += 1) {
    const rateAmount = random() % 10_000_001;
    const selectedRule = rules[random() % rules.length];
    const result = calculateBillingUnitAmount({
      billingRule: selectedRule,
      distanceBandAmountMinor: rateAmount,
      dropCount: 1 + (random() % 50),
      mbbsChargingPolicy: policy(random() % 1_000_001, random() % 1_000_001)
    });
    assert.equal(result.calculatedAmountMinor, rateAmount);
    assert.equal(result.additionalDropCount, 0);
    assert.equal(result.additionalDropUnitAmountMinor, 0);
  }
});

test("generated unsafe PO products fail closed instead of losing cent precision", () => {
  for (const dropCount of [2, 3, 10, 1_000_000]) {
    assert.throws(
      () => calculateBillingUnitAmount({
        billingRule: "po_shared_leg",
        distanceBandAmountMinor: 1,
        dropCount,
        mbbsChargingPolicy: policy(0, Number.MAX_SAFE_INTEGER)
      }),
      (error) => error?.code === "MBT_BILLING_MANUAL_AMOUNT_INVALID"
    );
  }
});

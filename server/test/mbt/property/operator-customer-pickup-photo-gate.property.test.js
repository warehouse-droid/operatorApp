// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { materializeOperatorCustomerPickupPhotoRequirement } from
  "../../../src/operator-customer-pickup-photo-policy.js";

const hostileValues = Object.freeze([
  undefined,
  null,
  true,
  false,
  0,
  1,
  "",
  "false",
  "true",
  Symbol("hostile-revision"),
  [],
  {},
  { valueOf: () => false }
]);

test("S5 property: across hostile values, explicit false is the sole opt-out", () => {
  let examples = 0;
  for (const enabled of hostileValues) {
    for (const revision of hostileValues) {
      const policy = materializeOperatorCustomerPickupPhotoRequirement({ enabled, revision });
      const expectedRequired = enabled !== false;
      assert.equal(policy.required, expectedRequired, `enabled=${String(enabled)}`);
      assert.equal(policy.requiredPhotoCount, expectedRequired ? 1 : 0);
      assert.ok(policy.requiredPhotoCount === 0 || policy.requiredPhotoCount === 1);
      examples += 1;
    }
  }
  assert.equal(examples, hostileValues.length ** 2);
});

test("S5 property: missing rows always retain the safe one-photo requirement", () => {
  for (let index = 0; index < 1_000; index += 1) {
    const row = index % 2 === 0 ? null : undefined;
    const policy = materializeOperatorCustomerPickupPhotoRequirement(row);
    assert.equal(policy.required, true);
    assert.equal(policy.requiredPhotoCount, 1);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  MBT_LOCAL_ITEM_POLICIES,
  normalizeMbtLocalItemUpdate
} from "../../../src/mbt/local-item-settings.js";

function fixedPolicy() {
  const found = MBT_LOCAL_ITEM_POLICIES.find(({ itemCode }) => itemCode === "14YD");
  assert.ok(found);
  return found;
}

test("LC03-R1 property: bounded local presentation text normalizes deterministically", () => {
  const display = fc.string({ minLength: 1, maxLength: 150 })
    .filter((value) => value.trim().length > 0);
  const description = fc.string({ maxLength: 1900 });
  fc.assert(fc.property(display, description, fc.boolean(), (name, detail, active) => {
    const normalized = normalizeMbtLocalItemUpdate({
      displayName: name,
      description: detail,
      active
    }, fixedPolicy());
    assert.deepEqual(normalized, {
      displayName: name.trim(),
      description: detail.trim(),
      active
    });
  }), { numRuns: 1000 });
});

test("LC03-R1 property: no possible local money or UOM field is accepted", () => {
  fc.assert(fc.property(
    fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
    fc.string({ maxLength: 20 }),
    (amount, unit) => {
      assert.throws(() => normalizeMbtLocalItemUpdate({
        displayName: "14 yard",
        description: "Rate-card priced",
        active: true,
        defaultUnitAmountMinor: amount,
        unitOfMeasure: unit
      }, fixedPolicy()));
    }
  ), { numRuns: 1000 });
});

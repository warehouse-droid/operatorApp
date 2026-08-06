import assert from "node:assert/strict";
import test from "node:test";

import { MbtError } from "../../../src/mbt/errors.js";
import {
  MBT_LOCAL_ITEM_POLICIES,
  normalizeMbtLocalItemUpdate
} from "../../../src/mbt/local-item-settings.js";

const EXPECTED_POLICIES = Object.freeze([
  {
    itemCode: "DELIVERY_CROSS_CHARGE",
    itemType: "delivery_fee",
    category: "cross_charge",
    priceMode: "rate_card",
    applicableSourceTypes: ["SO", "TO", "PO", "VRMA"],
    binTypeCode: null,
    netSuiteMappingLocalKey: "delivery_charge"
  },
  {
    itemCode: "14YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "14YD",
    netSuiteMappingLocalKey: "bin_14yd"
  },
  {
    itemCode: "20YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "20YD",
    netSuiteMappingLocalKey: "bin_20yd"
  },
  {
    itemCode: "40YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "40YD",
    netSuiteMappingLocalKey: "bin_40yd"
  },
  {
    itemCode: "DUMP",
    itemType: "dump",
    category: "dump",
    priceMode: "rate_card",
    applicableSourceTypes: [],
    binTypeCode: null,
    netSuiteMappingLocalKey: null
  }
]);

function setting(overrides = {}) {
  return {
    displayName: "14 yard bin charge",
    description: "14 yard bin service",
    active: true,
    ...overrides
  };
}

function policy(itemCode) {
  const found = MBT_LOCAL_ITEM_POLICIES.find((entry) => entry.itemCode === itemCode);
  assert.ok(found, `Missing policy ${itemCode}`);
  return found;
}

function assertMbtError(code) {
  return (error) => error instanceof MbtError && error.status === 400 && error.code === code;
}

test("LC01/LC04: the five local item identities are exact, ordered, and deeply frozen", () => {
  assert.deepEqual(MBT_LOCAL_ITEM_POLICIES, EXPECTED_POLICIES);
  assert.ok(Object.isFrozen(MBT_LOCAL_ITEM_POLICIES));
  assert.ok(MBT_LOCAL_ITEM_POLICIES.every((entry) => (
    Object.isFrozen(entry) && Object.isFrozen(entry.applicableSourceTypes)
  )));
  assert.throws(() => {
    MBT_LOCAL_ITEM_POLICIES[0].itemCode = "MUTATED";
  }, TypeError);
  assert.throws(() => {
    MBT_LOCAL_ITEM_POLICIES[0].applicableSourceTypes.push("BAD");
  }, TypeError);
});

test("LC03-R1: a local presentation update is bounded and contains no money or UOM", () => {
  assert.deepEqual(normalizeMbtLocalItemUpdate(setting({
    displayName: "  14 yard bin charge  ",
    description: "  Configured through the approved rate card.  ",
    active: false
  }), policy("14YD")), {
    displayName: "14 yard bin charge",
    description: "Configured through the approved rate card.",
    active: false
  });
});

test("LC03-R1: custom local items use the same presentation-only update boundary", () => {
  assert.deepEqual(normalizeMbtLocalItemUpdate(setting({
    displayName: "  Clean concrete  ",
    description: "  Customer dump charge per tonne.  "
  }), { itemCode: "CLEAN_CONCRETE" }), {
    displayName: "Clean concrete",
    description: "Customer dump charge per tonne.",
    active: true
  });
});

test("LC03-R1/LC04: malformed, extra, pricing, or identity-changing fields fail closed", () => {
  const invalidInputs = [
    null,
    [],
    setting({ displayName: "" }),
    setting({ displayName: "x".repeat(161) }),
    setting({ description: "x".repeat(2001) }),
    setting({ active: "true" }),
    setting({ itemCode: "20YD" }),
    setting({ category: "dump" }),
    setting({ priceMode: "custom_price" }),
    setting({ applicableSourceTypes: ["SO"] }),
    setting({ currency: "USD" }),
    setting({ binTypeCode: "20YD" }),
    setting({ netSuiteMappingLocalKey: "other" }),
    setting({ defaultUnitAmountMinor: 12500 }),
    setting({ unitOfMeasure: "EA" }),
    { ...setting(), unexpected: true }
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => normalizeMbtLocalItemUpdate(input, policy("14YD")),
      assertMbtError("MBT_LOCAL_ITEM_INPUT_INVALID"),
      JSON.stringify(input)
    );
  }
});

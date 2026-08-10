// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMbtLocalItemUpdate } from "../../../src/mbt/local-item-settings.js";
import {
  normalizeLocalMasterDataRow
} from "../../../src/mbt/local-master-data-service.js";

function item(overrides = {}) {
  return {
    itemCode: "CLEAR_STONE",
    displayName: "Clear stone",
    description: "Locally sold aggregate",
    itemType: "aggregate",
    chargeBasis: "per_yard",
    densityLbsPerYard: 2_750,
    rentalPeriodDays: null,
    applicableServiceTypes: ["delivery", "exchange"],
    applicableLegacySourceTypes: [],
    binTypeCode: null,
    binCapacityYards: null,
    netSuiteMappingLocalKey: null,
    active: true,
    ...overrides
  };
}

test("aggregate is a real local item with a fixed per-yard basis and dispatch density", () => {
  assert.deepEqual(normalizeLocalMasterDataRow("local_items", item()), {
    itemCode: "CLEAR_STONE",
    displayName: "Clear stone",
    description: "Locally sold aggregate",
    itemType: "aggregate",
    chargeBasis: "per_yard",
    densityLbsPerYard: 2_750,
    rentalPeriodDays: null,
    category: "other",
    pricingMode: "rate_card",
    applicableServiceTypes: ["delivery", "exchange"],
    applicableLegacySourceTypes: [],
    binTypeCode: null,
    netSuiteMappingLocalKey: null,
    active: true
  });
});

test("dump items can be created and edited as either per-tonne or fixed per-bin", () => {
  const fixed = normalizeLocalMasterDataRow("local_items", item({
    itemCode: "SOIL",
    displayName: "Soil",
    itemType: "dump",
    chargeBasis: "per_bin",
    densityLbsPerYard: null,
    applicableServiceTypes: ["dump_return"]
  }));
  assert.equal(fixed.chargeBasis, "per_bin");
  assert.equal(fixed.densityLbsPerYard, null);

  assert.deepEqual(normalizeMbtLocalItemUpdate({
    displayName: "Soil",
    description: "Fixed customer dump charge",
    chargeBasis: "per_bin",
    active: true
  }, { itemCode: "SOIL", itemType: "dump" }), {
    displayName: "Soil",
    description: "Fixed customer dump charge",
    chargeBasis: "per_bin",
    active: true
  });

  assert.equal(normalizeLocalMasterDataRow("local_items", item({
    itemCode: "ASPHALT",
    displayName: "Asphalt",
    itemType: "dump",
    chargeBasis: "per_tonne",
    densityLbsPerYard: null,
    applicableServiceTypes: ["dump_return"]
  })).chargeBasis, "per_tonne");
});

test("invalid item/basis/density combinations fail closed", () => {
  for (const invalid of [
    item({ chargeBasis: "per_bin" }),
    item({ densityLbsPerYard: null }),
    item({ densityLbsPerYard: 0 }),
    item({ itemType: "dump", chargeBasis: "per_yard", densityLbsPerYard: null }),
    item({ itemType: "delivery_fee", chargeBasis: "per_tonne", densityLbsPerYard: null })
  ]) {
    assert.throws(
      () => normalizeLocalMasterDataRow("local_items", invalid),
      (error) => error?.code === "MBT_LOCAL_ITEM_INPUT_INVALID"
    );
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import fc from "fast-check";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
const start = source.indexOf("function isCustomerPickupMode"), end = source.indexOf("function receivingRemainingSalesQty", start);
function ui() {
  const context = vm.createContext({ currentModule: "delivery", viewMode: "packed", selectedOrder: {},
    qty: value => Number(value) || 0, PICKABLE_ITEM_TYPES: new Set(["InvtPart", "NonInvtPart"]),
    t: (_key, fallback) => fallback, orderLocksCurrentOperator: () => false });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("Operator resolves 93.26 SQFT to eight layers without a fractional leftover", () => {
  const view = ui(), line = { quantity: 93.26, layer_qty: 8, to_lyr: 11.657, packed_layer_qty: 8, item_type: "InvtPart" };
  assert.equal(view.wholeUnitsFromSalesQty(93.26, 11.657), 8);
  assert.equal(view.remainingValue(line, "layers"), 0);
  assert.equal(view.hasRemainingQty(line), false);
  assert.equal(view.isUnderPacked(line), false);
  assert.equal(view.hasRemainingQty({ ...line, packed_layer_qty: 7 }), true);
});

test("property: 1000 converted pallet/layer totals keep whole physical quantities after sales rounding", () => {
  const view = ui();
  fc.assert(fc.property(fc.constantFrom(["pallet", "to_plt", "pallets"], ["layer", "to_lyr", "layers"]),
    fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1000, max: 250000 }), (unit, count, conversionTicks) => {
      const [field, conversionField, label] = unit, conversion = conversionTicks / 1000;
      const salesHundredths = Math.round(count * conversionTicks / 10);
      const line = { quantity: salesHundredths / 100, [`${field}_qty`]: count, [conversionField]: conversion,
        [`packed_${field}_qty`]: count, item_type: "InvtPart" };
      assert.equal(view.wholeUnitsFromSalesQty(line.quantity, conversion), count);
      assert.equal(view.remainingValue(line, label), 0);
      assert.equal(view.hasRemainingQty(line), false);
      assert.equal(view.hasRemainingQty({ ...line, [`packed_${field}_qty`]: count - 1 }), true);
    }), { seed: 20260915, numRuns: 1000 });
});

test("property: exact tolerance boundary rounds to the whole package while larger differences stay short", () => {
  const view = ui();
  fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1000, max: 250000 }), (count, conversionTicks) => {
    const targetTicks = count * conversionTicks - 100;
    assert.equal(view.wholeUnitsFromSalesQty(targetTicks / 1000, conversionTicks / 1000), count);
    assert.equal(view.wholeUnitsFromSalesQty((targetTicks * 1000 - 1) / 1000000, conversionTicks / 1000), count - 1);
  }), { seed: 20260915, numRuns: 1000, examples: [[8, 11657]] });
});

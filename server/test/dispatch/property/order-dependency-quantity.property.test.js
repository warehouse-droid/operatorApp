import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  dependencyHasEffectiveMaterial,
  dependencyQuantityConversionDisplay,
  resolveDependencyLineContributions
} from "../../../src/order-dependency-quantity.js";

const SEED = 20_260_827;
const RUNS = 500;

function total(lines, field) {
  return lines.reduce((sum, line) => sum + Number(line[field] || 0), 0);
}

test("partial TO contribution property: every item conserves its independent outbound budget", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }),
    fc.integer({ min: 0, max: 100_000 }),
    (allocations, available) => {
      const source = allocations.map((allocatedQuantity, index) => ({
        id: index + 1,
        itemId: "ITEM-A",
        lineRole: "sales_allocation",
        allocatedQuantity,
        transferOutboundQuantity: available,
        transferReceivingQuantity: available,
        palletQty: 0,
        layerQty: 0,
        sectionQty: 0,
        pieceQty: allocatedQuantity,
        toPcs: 1
      }));
      const resolved = resolveDependencyLineContributions(source);
      const allocatedTotal = total(source, "allocatedQuantity");

      assert.equal(total(resolved, "allocatedQuantity"), allocatedTotal);
      assert.equal(total(resolved, "effectiveAllocatedQuantity"), Math.min(allocatedTotal, available));
      assert.deepEqual(resolveDependencyLineContributions(source), resolved);
      resolved.forEach((line, index) => {
        assert.equal(line.allocatedQuantity, allocations[index]);
        assert.ok(line.effectiveAllocatedQuantity >= 0);
        assert.ok(line.effectiveAllocatedQuantity <= line.allocatedQuantity);
        assert.equal(line.quantityLimited, line.effectiveAllocatedQuantity < line.allocatedQuantity);
        assert.equal(line.effectivePieceQty, line.effectiveAllocatedQuantity);
      });
    }
  ), { seed: SEED, numRuns: RUNS });
});

test("partial TO contribution property: item budgets are isolated and non-SO lines remain unchanged", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 10_000 }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.integer({ min: 0, max: 10_000 }),
    (allocatedA, availableA, allocatedB, availableB) => {
      const source = [
        {
          id: 1,
          itemId: "ITEM-A",
          lineRole: "sales_allocation",
          allocatedQuantity: allocatedA,
          transferOutboundQuantity: availableA,
          pieceQty: allocatedA,
          toPcs: 1
        },
        {
          id: 2,
          itemId: "ITEM-B",
          lineRole: "sales_allocation",
          allocatedQuantity: allocatedB,
          transferOutboundQuantity: availableB,
          pieceQty: allocatedB,
          toPcs: 1
        },
        {
          id: 3,
          itemId: "PALLET",
          lineRole: "pallet",
          allocatedQuantity: 7,
          transferOutboundQuantity: 1,
          pieceQty: 7,
          toPcs: 1
        }
      ];
      const resolved = resolveDependencyLineContributions(source);

      assert.equal(resolved[0].effectiveAllocatedQuantity, Math.min(allocatedA, availableA));
      assert.equal(resolved[1].effectiveAllocatedQuantity, Math.min(allocatedB, availableB));
      assert.equal(resolved[2].effectiveAllocatedQuantity, 7);
      assert.equal(resolved[2].effectivePieceQty, 7);
      assert.equal(resolved[2].quantityLimited, false);
    }
  ), { seed: SEED + 1, numRuns: RUNS });
});

test("partial TO contribution boundaries preserve unknown quantities, receiving fallback, and conversions", () => {
  assert.deepEqual(resolveDependencyLineContributions(null), []);
  const [unknown, receiving, converted] = resolveDependencyLineContributions([
    {
      id: 1,
      itemName: "UNKNOWN",
      allocatedQuantity: "1,200",
      transferOutboundQuantity: null,
      transferReceivingQuantity: null,
      palletQty: 12,
      pieceQty: 0
    },
    {
      id: 2,
      itemName: "RECEIVING",
      allocatedQuantity: 8,
      transferOutboundQuantity: null,
      transferReceivingQuantity: 3,
      pieceQty: 8,
      toPcs: 1
    },
    {
      id: 3,
      itemName: "CONVERTED",
      allocatedQuantity: 27,
      transferOutboundQuantity: 17,
      palletQty: 2,
      layerQty: 1,
      sectionQty: 1,
      pieceQty: 1,
      toPlt: 10,
      toLyr: 5,
      toSec: 2,
      toPcs: 1
    }
  ]);
  assert.equal(unknown.effectiveAllocatedQuantity, 1200);
  assert.equal(unknown.quantityLimited, false);
  assert.equal(receiving.effectiveAllocatedQuantity, 3);
  assert.equal(receiving.effectivePieceQty, 3);
  assert.equal(converted.effectiveAllocatedQuantity, 17);
  assert.deepEqual(
    {
      pallets: converted.effectivePalletQty,
      layers: converted.effectiveLayerQty,
      sections: converted.effectiveSectionQty,
      pieces: converted.effectivePieceQty
    },
    { pallets: 1, layers: 1, sections: 1, pieces: 0 }
  );
  assert.deepEqual(dependencyQuantityConversionDisplay(3, {}), {
    palletQty: 0,
    layerQty: 0,
    sectionQty: 0,
    pieceQty: 3
  });
  assert.deepEqual(dependencyQuantityConversionDisplay(-3, { to_pcs: 2 }), {
    palletQty: 0,
    layerQty: 0,
    sectionQty: 0,
    pieceQty: 1.5
  });
  assert.deepEqual(dependencyQuantityConversionDisplay("not-a-quantity", { to_pcs: "invalid" }), {
    palletQty: 0,
    layerQty: 0,
    sectionQty: 0,
    pieceQty: 0
  });
  const [invalidOutbound] = resolveDependencyLineContributions([{
    id: 99,
    itemId: "",
    itemName: "",
    allocatedQuantity: 5,
    transferOutboundQuantity: "invalid",
    transferReceivingQuantity: "4",
    pieceQty: 5,
    toPcs: 1
  }]);
  assert.equal(invalidOutbound.effectiveAllocatedQuantity, 4);
});

test("direct routing material boundary distinguishes unknown, positive, and explicit zero", () => {
  assert.equal(dependencyHasEffectiveMaterial({}), true);
  assert.equal(dependencyHasEffectiveMaterial({
    lines: [{ lineRole: "pallet", allocatedQuantity: 7, effectiveAllocatedQuantity: 7 }]
  }), true);
  assert.equal(dependencyHasEffectiveMaterial({
    lines: [{ lineRole: "sales_allocation", allocatedQuantity: 7, effectiveAllocatedQuantity: 2 }]
  }), true);
  assert.equal(dependencyHasEffectiveMaterial({
    lines: [{ lineRole: "sales_allocation", allocatedQuantity: 7 }]
  }), true);
  assert.equal(dependencyHasEffectiveMaterial({
    lines: [{ lineRole: "sales_allocation", allocatedQuantity: 7, effectiveAllocatedQuantity: 0 }]
  }), false);
});

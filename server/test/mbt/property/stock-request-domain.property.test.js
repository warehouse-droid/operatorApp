import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  groupStockRequestLinesForTransfer,
  normalizeStockRequestQuantity,
  stockRequestAvailableQuantity,
  stockRequestBackorder,
  stockRequestPalletQuantity
} from "../../../src/stock-request-domain.js";

test("conversion normalization conserves randomized exact component quantities", () => {
  fc.assert(fc.property(
    fc.record({
      pallets: fc.integer({ min: 0, max: 1000 }),
      layers: fc.integer({ min: 0, max: 1000 }),
      sections: fc.integer({ min: 0, max: 1000 }),
      pieces: fc.integer({ min: 0, max: 1000 })
    }).filter((input) => Object.values(input).some((value) => value > 0)),
    (input) => {
      const result = normalizeStockRequestQuantity(input, {
        stockUnit: "EA",
        toPlt: 1000,
        toLyr: 100,
        toSec: 10,
        toPcs: 1
      });
      assert.equal(
        result.salesQty,
        (input.pallets * 1000) + (input.layers * 100) + (input.sections * 10) + input.pieces
      );
      assert.equal(result.mode, "conversion");
    }
  ), { numRuns: 1000 });
});

test("requestable availability is always within zero and live availability", () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    (liveAvailable, activeReserved) => {
      const result = stockRequestAvailableQuantity({ liveAvailable, activeReserved });
      assert(result >= 0);
      assert(result <= liveAvailable + Number.EPSILON);
    }
  ), { numRuns: 1000 });
});

test("backorder always fills the exact gap between desired and requestable quantity", () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
    (requestedQuantity, liveAvailable, activeReserved, ownReserved) => {
      const result = stockRequestBackorder({ requestedQuantity, liveAvailable, activeReserved, ownReserved });
      const expectedAvailable = Math.max(0, liveAvailable - Math.max(0, activeReserved - ownReserved));
      assert(result.requestableAvailable >= 0);
      assert(result.backorderQuantity >= 0);
      assert.equal(result.requestableAvailable, expectedAvailable);
      assert.equal(result.backorderQuantity, Math.max(0, requestedQuantity - result.requestableAvailable));
    }
  ), { numRuns: 1000 });
});

test("route grouping neither loses nor duplicates randomized request lines", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      sourceLocationId: fc.constantFrom(1, 28, 15, 26),
      destinationLocationId: fc.constantFrom(1, 28, 15, 26)
    }).filter((line) => line.sourceLocationId !== line.destinationLocationId), { minLength: 1, maxLength: 100 }),
    (input) => {
      const lines = input.map((line, index) => ({ ...line, id: index + 1 }));
      const grouped = groupStockRequestLinesForTransfer(lines);
      const foundIds = grouped.flatMap((group) => group.lines.map((line) => line.id)).sort((a, b) => a - b);
      assert.deepEqual(foundIds, lines.map((line) => line.id));
      assert.equal(new Set(grouped.map((group) => group.key)).size, grouped.length);
      for (const group of grouped) {
        assert(group.lines.every((line) => line.sourceLocationId === group.sourceLocationId));
        assert(group.lines.every((line) => line.destinationLocationId === group.destinationLocationId));
      }
    }
  ), { numRuns: 500 });
});

test("automatic PALLET quantity equals the sum of per-SKU ceilings", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      salesQty: fc.integer({ min: 1, max: 100_000 }),
      toPlt: fc.integer({ min: 1, max: 500 })
    }), { minLength: 1, maxLength: 50 }),
    (input) => {
      const lines = input.map((line, index) => ({ ...line, itemId: index + 1 }));
      const result = stockRequestPalletQuantity(lines);
      assert.equal(result.requiresManualQuantity, false);
      assert.equal(
        result.automaticQuantity,
        lines.reduce((sum, line) => sum + Math.ceil(line.salesQty / line.toPlt), 0)
      );
    }
  ), { numRuns: 500 });
});

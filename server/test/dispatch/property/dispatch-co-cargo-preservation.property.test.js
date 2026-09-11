import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { applyLocalCoCargo } from "../../../src/dispatch-local-co-cargo.js";
import { coFixture, staleCoFixture } from "../../support/co-cargo-fixture.mjs";

test("CO authority conserves persisted quantities and is immutable and idempotent across 1000 manifests", () => {
  fc.assert(fc.property(fc.array(fc.record({
    quantity: fc.integer({ min: 0, max: 100000 }), pallet_qty: fc.integer({ min: 0, max: 100 }),
    layer_qty: fc.integer({ min: 0, max: 20 }), section_qty: fc.integer({ min: 0, max: 20 }),
    piece_qty: fc.integer({ min: 0, max: 1000 })
  }), { minLength: 1, maxLength: 20 }), (lines) => {
    const stale = staleCoFixture();
    const before = structuredClone(stale);
    const record = { coRef: stale.id, cargoLines: lines.map((line, index) => ({
      ...line, line_id: index + 1, item_id: index + 1, sku: `PRODUCT-${index}`, item_weight: 2,
      raw: { quantity: -100, pallets: -100, poAllocatedPallets: 500, poAllocatedSalesQty: 500,
        poAllocatedLayers: 500, poAllocatedSections: 500, poAllocatedPieces: 500 }
    })), details: { childOrderIds: [], childOrderDetails: [] } };
    const restored = applyLocalCoCargo(stale, record);
    assert.deepEqual(restored.items.map((i) => i.quantity), lines.map((l) => l.quantity));
    for (const item of restored.items) {
      for (const key of ["poAllocatedPallets", "poAllocatedSalesQty", "poAllocatedLayers", "poAllocatedSections", "poAllocatedPieces"]) {
        assert.equal(Number(item[key] || 0), 0);
      }
    }
    assert.equal(restored.pallets, lines.reduce((sum, l) => sum + l.pallet_qty, 0));
    assert.equal(restored.layers, lines.reduce((sum, l) => sum + l.layer_qty, 0));
    assert.equal(restored.sections, lines.reduce((sum, l) => sum + l.section_qty, 0));
    assert.equal(restored.pieces, lines.reduce((sum, l) => sum + l.piece_qty, 0));
    assert.equal(restored.weight, lines.reduce((sum, l) => sum + l.quantity * 2, 0));
    assert.deepEqual(applyLocalCoCargo(restored, record), restored);
    assert.deepEqual(stale, before);
    assert.equal(applyLocalCoCargo(stale, { ...record, cargoLocked: true }), stale);
    assert.equal(applyLocalCoCargo(stale, { ...record, coRef: "OTHER" }), stale);
  }), { seed: 29677455, numRuns: 1000 });
});

test("missing authoritative CO lines are not permission to erase existing cargo", () => {
  const full = coFixture();
  for (const cargoLines of [undefined, null, [], "invalid"]) {
    assert.equal(applyLocalCoCargo(full, { coRef: full.id, cargoLines }), full);
  }
  assert.deepEqual(applyLocalCoCargo(), {});
});

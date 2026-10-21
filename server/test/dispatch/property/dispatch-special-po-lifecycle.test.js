import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectPurchaseOrderRouteResidual } from "../../../src/dispatch-po-route-projection.js";

test("special native allocation conserves proportional cargo and is immutable and idempotent", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1000000 }),
    fc.integer({ min: 1, max: 200 }),
    fc.integer({ min: 0, max: 150 }),
    (native, pallets, percent) => {
      const order = { id: "SPECIAL-PROPERTY", type: "PO", destinationYard: "2967",
        items: [{ lineRowId: "1", itemId: 2055, quantity: native / 100,
          pallets, layers: pallets * 2, sections: pallets * 3, pieces: pallets * 4 }] };
      const before = structuredClone(order);
      const allocations = [0.25, 0.75].map((share) => ({ po_line_id: "1", status: "active",
        allocated_sales_qty: native / 100 * percent / 100 * share }));
      const projected = projectPurchaseOrderRouteResidual(order, allocations);
      const route = projected.poRouteProjection;
      const fraction = Math.max(1 - percent / 100, 0);
      for (const [field, scale] of [["pallets", 1], ["layers", 2], ["sections", 3], ["pieces", 4]]) {
        assert.ok(Math.abs(route[field] - pallets * scale * fraction) < 0.000002, field);
      }
      assert.ok(Math.abs(route.salesQty - native / 100 * fraction) < 0.000002);
      assert.equal(route.hasResidual, percent < 100);
      assert.deepEqual(order, before);
      assert.deepEqual(projectPurchaseOrderRouteResidual(projected, allocations), projected);
      const inactive = allocations.map((row) => ({ ...row, status: "released" }));
      assert.equal(projectPurchaseOrderRouteResidual(order, inactive, { force: true }).poRouteProjection.pallets, pallets);
    }
  ), { numRuns: 1000, seed: 35925 });
});

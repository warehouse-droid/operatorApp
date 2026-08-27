import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { projectPurchaseOrderRouteResidual } from "../../../src/dispatch-po-route-projection.js";

const quantities = fc.record({
  pallets: fc.integer({ min: 0, max: 250 }),
  layers: fc.integer({ min: 0, max: 250 }),
  sections: fc.integer({ min: 0, max: 250 }),
  pieces: fc.integer({ min: 0, max: 250 }),
  salesQty: fc.integer({ min: 0, max: 5000 })
});

test("property: residual quantities are conserved, clamped, idempotent, and source-immutable", () => {
  fc.assert(fc.property(
    quantities,
    fc.array(quantities, { minLength: 0, maxLength: 12 }),
    (source, allocatedRows) => {
      const order = {
        id: "PO-PROPERTY",
        type: "PO",
        destinationYard: "3445",
        items: [{
          lineRowId: "line-1",
          sku: "PROPERTY-SKU",
          destinationYard: "3445",
          pallets: source.pallets,
          layers: source.layers,
          sections: source.sections,
          pieces: source.pieces,
          quantity: source.salesQty,
          itemWeight: 2
        }],
        dropoffs: [{
          key: "yard:3445",
          destinationYard: "3445",
          address: "3445 Kennedy Road, Toronto, ON",
          lineRowIds: ["line-1"]
        }]
      };
      const before = structuredClone(order);
      const allocations = allocatedRows.map((row, index) => ({
        id: index + 1,
        status: "active",
        dispatch_target_ref: `SO-${index % 3}`,
        po_order_ref: order.id,
        po_line_id: "line-1",
        allocated_pallet_qty: row.pallets,
        allocated_layer_qty: row.layers,
        allocated_section_qty: row.sections,
        allocated_piece_qty: row.pieces,
        allocated_sales_qty: row.salesQty
      }));
      const projected = projectPurchaseOrderRouteResidual(order, allocations, {
        force: true,
        targetRefs: ["SO-RELEASED"]
      });
      const residual = projected.poRouteProjection;
      const expected = (field) => Math.max(
        source[field] - allocatedRows.reduce((sum, row) => sum + row[field], 0),
        0
      );

      assert.deepEqual(order, before);
      for (const field of ["pallets", "layers", "sections", "pieces"]) {
        assert.equal(residual[field], expected(field));
        assert.ok(residual[field] >= 0 && residual[field] <= source[field]);
      }
      assert.equal(residual.salesQty, expected("salesQty"));
      assert.equal(residual.dropoffs.reduce((sum, dropoff) => sum + dropoff.pallets, 0), residual.pallets);
      assert.deepEqual(
        projectPurchaseOrderRouteResidual(projected, allocations, {
          force: true,
          targetRefs: ["SO-RELEASED"]
        }),
        projected
      );
    }
  ), { numRuns: 1000 });
});

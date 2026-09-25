import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { applyOperatorLinkedQuantityProjection, sumActiveLinkedQuantities } from "../../../src/operator-linked-quantity-domain.js";
import { specialLine } from "../../support/operator-display-refresh-fixture.mjs";

test("L1 a fully PO supplied sales line retains manual pallet annotations as reference only", () => {
  const line = applyOperatorLinkedQuantityProjection(specialLine, { linkedPo: { sales: 2332 } });
  assert.equal(line.no_yard_load_required, true);
  assert.equal(line.original_quantity, 2332);
  assert.equal(line.linked_po_sales_qty, 2332);
  assert.equal(line.operator_required_sales_qty, 0);
  assert.equal(line.original_pallet_qty, 20);
  assert.equal(line.pallet_qty, 20, "retain source-unit subtraction for compatibility, not yard work");
  assert.equal(line.linked_quantity_blocked, false);
});

test("L3 partial/cancelled allocations and physical-only manual requirements remain packable", () => {
  const partial = applyOperatorLinkedQuantityProjection(specialLine, { linkedPo: { sales: 2000 } });
  assert.equal(partial.quantity, 332);
  assert.equal(partial.no_yard_load_required, false);
  const cancelled = sumActiveLinkedQuantities({ poAllocations: [{ status: "cancelled", sales: 2332 }] });
  assert.equal(applyOperatorLinkedQuantityProjection(specialLine, cancelled).quantity, 2332);
  const physical = applyOperatorLinkedQuantityProjection({ ...specialLine, quantity: 0 });
  assert.equal(physical.no_yard_load_required, false);
  assert.equal(physical.pallet_qty, 20);
  const converted = applyOperatorLinkedQuantityProjection({ ...specialLine, to_plt: 116.6 }, { linkedPo: { sales: 2332 } });
  assert.equal(converted.no_yard_load_required, false);
  assert.equal(converted.operator_required_pallet_qty, 20);
  const over = applyOperatorLinkedQuantityProjection(specialLine, { linkedPo: { sales: 2333 } });
  assert.equal(over.linked_quantity_blocked, true);
  assert.equal(over.linked_quantity_errors[0].unit, "sales");
});

test("L1 sales residual determines no-yard work regardless of manual pallet annotation", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 100 }),
    (quantity, pallets, percent) => {
      const sales = Number((quantity * percent / 100).toFixed(6));
      const line = applyOperatorLinkedQuantityProjection({ ...specialLine, quantity, pallet_qty: pallets }, { linkedPo: { sales } });
      assert.equal(line.no_yard_load_required, percent === 100);
      assert.equal(Number((line.quantity + line.linked_po_sales_qty).toFixed(6)), quantity);
      assert.equal(line.original_pallet_qty, pallets);
    }
  ), { numRuns: 150, seed: 20260918 });
});

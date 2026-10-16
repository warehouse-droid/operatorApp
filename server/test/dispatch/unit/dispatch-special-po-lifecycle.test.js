import assert from "node:assert/strict";
import test from "node:test";
import { projectPurchaseOrderRouteResidual } from "../../../src/dispatch-po-route-projection.js";

function source({ quantity = 1063.81, itemId = 2055 } = {}) {
  return {
    id: "LOINC-035925", type: "PO", destinationYard: "2967",
    items: [{ lineRowId: "material", itemId, quantity, pallets: 11,
      layers: 2, sections: 4, pieces: 6, lineWeight: 20000 }]
  };
}

const allocation = (salesQty, extra = {}) => ({
  po_line_id: "material", allocated_sales_qty: salesQty,
  dispatch_target_ref: "GOA-9261-9263", status: "active", ...extra
});

test("LOINC-035925 full native special link has no phantom pallet residual", () => {
  const order = source();
  const before = structuredClone(order);
  const projected = projectPurchaseOrderRouteResidual(order, [allocation(1063.81)]);
  assert.equal(projected.poRouteProjection.hasResidual, false);
  assert.deepEqual(projected.poRouteProjection.items, []);
  assert.deepEqual(projected.poRouteProjection.dropoffs, []);
  assert.equal(projected.poRouteProjection.weight, 0);
  assert.deepEqual(order, before);
  assert.deepEqual(projected.items, before.items);
});

test("partial special links retain proportional display cargo and native residual", () => {
  const projected = projectPurchaseOrderRouteResidual(source({ quantity: 100 }), [allocation(25)]);
  const route = projected.poRouteProjection;
  assert.equal(route.hasResidual, true);
  assert.equal(route.salesQty, 75);
  assert.equal(route.pallets, 8.25);
  assert.equal(route.layers, 1.5);
  assert.equal(route.sections, 3);
  assert.equal(route.pieces, 4.5);
  assert.equal(route.weight, 15000);
});

test("inactive, unrelated, unknown-native and ordinary-stock quantities retain physical cargo", () => {
  for (const [order, rows] of [
    [source(), [allocation(1063.81, { status: "released" })]],
    [source(), [allocation(1063.81, { po_line_id: "another-line" })]],
    [source({ quantity: 0 }), [allocation(10)]],
    [source({ itemId: 2874 }), [allocation(1063.81)]]
  ]) {
    const route = projectPurchaseOrderRouteResidual(order, rows, { force: true }).poRouteProjection;
    assert.equal(route.hasResidual, true);
    assert.equal(route.pallets, 11);
  }
});

test("legacy physical special links stay bounded and unlink restores immutable source", () => {
  const order = source({ quantity: 100 });
  const rows = [allocation(25, { allocated_pallet_qty: 4 })];
  const projected = projectPurchaseOrderRouteResidual(order, rows);
  assert.equal(projected.poRouteProjection.pallets, 7);
  const released = projectPurchaseOrderRouteResidual(projected, [], { force: true });
  assert.equal(released.poRouteProjection.pallets, 11);
  assert.equal(released.poRouteProjection.salesQty, 100);
  assert.deepEqual(released.items, order.items);
});

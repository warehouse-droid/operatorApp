import assert from "node:assert/strict";
import test from "node:test";

import { projectPurchaseOrderRouteResidual } from "../../../src/dispatch-po-route-projection.js";

test("hostile allocation values cannot inflate, poison, or subtract another PO line", () => {
  const order = {
    id: "PO-HOSTILE",
    type: "PO",
    destinationYard: "3445",
    pallets: 10,
    items: [
      { lineRowId: "A", itemId: 1, sku: "DUPLICATE", destinationYard: "3445", pallets: 10, quantity: 100, itemWeight: 2 },
      { lineRowId: "B", itemId: 1, sku: "DUPLICATE", destinationYard: "12441", pallets: 5, quantity: 50, itemWeight: 3 }
    ],
    dropoffs: [
      { key: "yard:3445", destinationYard: "3445", lineRowIds: ["A"], address: "3445 Kennedy Road" },
      { key: "yard:12441", destinationYard: "12441", lineRowIds: ["B"], address: "12441 Woodbine Avenue" }
    ]
  };
  const projected = projectPurchaseOrderRouteResidual(order, [
    {
      id: 1,
      status: "active",
      dispatch_target_ref: "SO-A",
      po_line_id: "A",
      allocated_pallet_qty: -500,
      allocated_sales_qty: Number.NaN
    },
    {
      id: 2,
      status: "cancelled",
      dispatch_target_ref: "SO-CANCELLED",
      po_line_id: "A",
      allocated_pallet_qty: 10,
      allocated_sales_qty: 100
    },
    {
      id: 3,
      status: "active",
      dispatch_target_ref: "SO-WRONG-LINE",
      po_line_id: "missing",
      item_id: 1,
      sku: "DUPLICATE",
      allocated_pallet_qty: Number.POSITIVE_INFINITY,
      allocated_sales_qty: 9999
    }
  ]);

  assert.deepEqual(projected.poRouteProjection.items.map((item) => [item.lineRowId, item.pallets, item.quantity]), [
    ["A", 10, 100],
    ["B", 5, 50]
  ]);
  assert.equal(projected.poRouteProjection.pallets, 15);
  assert.equal(projected.poRouteProjection.weight, 350);
  assert.deepEqual(projected.poRouteProjection.targetRefs, ["SO-A", "SO-WRONG-LINE"]);
});

test("legacy serialized and malformed allocation details cannot invent a fee route", () => {
  const order = {
    id: "PO-SERVICE-DETAILS",
    type: "PO",
    destinationYard: "3445",
    items: [
      { lineRowId: "material", sku: "MATERIAL", quantity: 1 },
      { lineRowId: "fee", sku: "MBBS-Special Order", description: "Split Pallet Fee", quantity: 1 }
    ]
  };
  const projected = projectPurchaseOrderRouteResidual(order, [
    {
      id: 10,
      status: "active",
      dispatch_target_ref: "SO-SERVICE",
      po_line_id: "material",
      allocated_sales_qty: 1,
      details: JSON.stringify({
        directServicePoLines: [{ poLineId: "fee", description: "Split Pallet Fee", quantity: 1 }]
      })
    },
    { id: 11, status: "active", dispatch_target_ref: "SO-SERVICE", details: "not-json" },
    { id: 12, status: "active", dispatch_target_ref: "SO-SERVICE", details: "[]" }
  ]).poRouteProjection;

  assert.equal(projected.hasResidual, false);
  assert.deepEqual(projected.items, []);
  assert.deepEqual(projected.directServiceLines, [{
    poLineId: "fee",
    description: "Split Pallet Fee",
    quantity: 1
  }]);
});

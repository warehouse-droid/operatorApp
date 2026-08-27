import assert from "node:assert/strict";
import test from "node:test";

import {
  smartScmApplyInboundOverlay,
  smartScmExpectedPoLineEligible,
  smartScmPlanningPhaseOneDrafts,
  smartScmSplitInboundOverlay
} from "../../../src/smart-scm-phased-planning.js";

test("integrated planning is unchanged while phased mode emits direct PO drafts only", () => {
  const drafts = [
    { proposalKey: "direct", proposalType: "PO", phase: "direct_vendor" },
    { proposalKey: "transfer", proposalType: "TO", phase: "internal_transfer" },
    { proposalKey: "hub", proposalType: "PO", phase: "vendor_hub" }
  ];
  assert.equal(smartScmPlanningPhaseOneDrafts(drafts, { mode: "integrated" }), drafts);
  assert.deepEqual(
    smartScmPlanningPhaseOneDrafts(drafts, { mode: "po_then_transfer" }),
    [drafts[0]]
  );
});

test("only real active open PO or split lines are expected inventory", () => {
  assert.equal(smartScmExpectedPoLineEligible({
    orderRef: "PO123",
    orderActive: true,
    lineActive: true,
    orderStatus: "Purchase Order : Pending Receipt",
    quantity: 10,
    receivedQuantity: 2
  }), true);
  assert.equal(smartScmExpectedPoLineEligible({
    proposalStatus: "order_requested",
    orderRef: "",
    orderActive: true,
    lineActive: true,
    quantity: 10
  }), false);
  assert.equal(smartScmExpectedPoLineEligible({
    orderRef: "PO-CLOSED",
    orderActive: true,
    lineActive: true,
    orderStatus: "Purchase Order : Closed",
    quantity: 10
  }), false);
  assert.equal(smartScmExpectedPoLineEligible({
    orderRef: "PO-RECEIVED",
    orderActive: true,
    lineActive: true,
    orderStatus: "Purchase Order : Pending Receipt",
    quantity: 10,
    receivedQuantity: 10
  }), false);
});

test("active split remaining quantity moves once from parent yard to child yard", () => {
  const overlay = smartScmSplitInboundOverlay({
    lines: [
      { splitRef: "PO-L1", itemId: 7, sourceLocationId: 15, destinationLocationId: 1, quantity: 10, receivedQuantity: 2, active: true },
      { splitRef: "PO-L2", itemId: 7, sourceLocationId: 15, destinationLocationId: 28, quantity: 6, receivedQuantity: 0, active: false },
      { splitRef: "PO-L3", itemId: 8, sourceLocationId: 15, destinationLocationId: 1, quantity: 5, receivedQuantity: 0, active: true, closed: true }
    ]
  });
  assert.deepEqual(overlay.deltas, [
    { itemId: 7, locationId: 15, quantity: -8 },
    { itemId: 7, locationId: 1, quantity: 8 }
  ]);
  assert.equal(overlay.evidence.length, 1);

  const balances = smartScmApplyInboundOverlay({
    balances: [
      { itemId: 7, locationId: 15, quantityOnOrder: 20 },
      { itemId: 7, locationId: 1, quantityOnOrder: 3 }
    ],
    deltas: overlay.deltas
  });
  assert.deepEqual(balances, [
    { itemId: 7, locationId: 15, quantityOnOrder: 12 },
    { itemId: 7, locationId: 1, quantityOnOrder: 11 }
  ]);
  assert.equal(balances.reduce((sum, row) => sum + row.quantityOnOrder, 0), 23);
});

test("PO evidence rejects every inactive or terminal representation", () => {
  assert.equal(smartScmExpectedPoLineEligible(null), false);
  assert.equal(smartScmExpectedPoLineEligible({
    order_ref: "PO-INACTIVE",
    order_active: false,
    line_active: true,
    remaining_quantity: 4
  }), false);
  assert.equal(smartScmExpectedPoLineEligible({
    split_ref: "PO-CANCEL-FLAG",
    order_active: true,
    line_active: true,
    cancelled: true,
    remaining_quantity: 4
  }), false);
  assert.equal(smartScmExpectedPoLineEligible({
    order_ref: "PO-FULL",
    order_active: true,
    line_active: true,
    order_status: "Purchase Order : Fully Received",
    remaining_quantity: 4
  }), false);
  assert.equal(smartScmExpectedPoLineEligible({
    order_ref: "PO-EXPLICIT",
    order_active: true,
    line_active: true,
    order_status: "Pending Receipt",
    remaining_quantity: 1.25
  }), true);
});

test("split inbound guards malformed and terminal rows while Blanket children add destination only", () => {
  const overlay = smartScmSplitInboundOverlay({
    lines: [
      { split_ref: "PO-BLANKET-L1", item_id: 10, source_location_id: 15, destination_location_id: 1, remaining_quantity: 4, line_active: true, source_already_excluded: true },
      { splitRef: "PO-BLANKET-L2", itemId: 10, sourceLocationId: 15, destinationLocationId: 1, quantity: 2, active: true, sourceAlreadyExcluded: true },
      { splitRef: "PO-SAME", itemId: 11, sourceLocationId: 1, destinationLocationId: 1, quantity: 5, active: true },
      { splitRef: "PO-NO-ITEM", sourceLocationId: 15, destinationLocationId: 1, quantity: 5, active: true },
      { splitRef: "PO-ZERO", itemId: 12, sourceLocationId: 15, destinationLocationId: 1, quantity: 0, active: true },
      { splitRef: "PO-CANCELLED", itemId: 13, sourceLocationId: 15, destinationLocationId: 1, quantity: 5, active: true, status: "Cancelled" }
    ]
  });
  assert.deepEqual(overlay.deltas, [{ itemId: 10, locationId: 1, quantity: 6 }]);
  assert.equal(overlay.evidence.length, 2);

  const balances = smartScmApplyInboundOverlay({
    balances: [{ item_id: 10, location_id: 1, quantity_on_order: 3 }],
    deltas: [
      ...overlay.deltas.map((row) => ({ item_id: row.itemId, location_id: row.locationId, quantity: row.quantity })),
      { itemId: 20, locationId: 28, quantity: 7 },
      { itemId: null, locationId: 28, quantity: 99 }
    ]
  });
  assert.deepEqual(balances, [
    { item_id: 10, location_id: 1, quantity_on_order: 9 },
    { itemId: 20, locationId: 28, quantityOnOrder: 7 }
  ]);
});

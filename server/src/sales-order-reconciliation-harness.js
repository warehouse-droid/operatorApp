import assert from "node:assert/strict";
import {
  filterDbBackedSalesOrderReconciliationCandidates,
  deriveSalesOrderReconciliationState,
  isNetSuiteSalesOrderBilled,
  isNetSuiteSalesOrderClosed,
  isNetSuiteSalesOrderFulfilled,
  isSalesOrderInventoryLine,
  mapNetSuiteSalesOrderLine,
  rollupGroupedSalesOrderReconciliation,
  scrubBilledSalesOrderFamilyFromPlan
} from "./sales-order-reconciliation.js";

const dbBackedCandidates = filterDbBackedSalesOrderReconciliationCandidates(
  [
    { kind: "SO", id: 101, tranid: "SO-LOCAL" },
    { kind: "SO", id: 102, tranid: "SO-NETSUITE-ONLY" },
    { kind: "SO", id: 201, tranid: "SO-COLLIDES-WITH-LOCAL-PO" },
    { kind: "PO", id: 201, tranid: "PO-UNCHANGED" },
    { kind: "TO", id: 301, tranid: "TO-UNCHANGED" }
  ],
  [
    { kind: "SO", id: 101, tranid: "SO-LOCAL" },
    { kind: "PO", id: 201, tranid: "PO-UNCHANGED" }
  ]
);
assert.deepEqual(
  dbBackedCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`),
  ["SO:101", "PO:201", "TO:301"],
  "SO reconciliation candidates must come from the local DB while PO/TO discovery remains unchanged."
);
for (let seed = 1; seed <= 100; seed += 1) {
  const localIds = Array.from({ length: seed % 11 }, (_, index) => seed * 100 + index + 1);
  const candidates = [
    ...localIds.map((id) => ({ kind: "SO", id })),
    { kind: "SO", id: seed * 100 + 99 },
    { kind: "PO", id: seed * 100 + 97 },
    { kind: "TO", id: seed * 100 + 98 }
  ];
  const filtered = filterDbBackedSalesOrderReconciliationCandidates(
    candidates,
    localIds.map((id) => ({ kind: "SO", id }))
  );
  const filteredSoIds = filtered
    .filter((candidate) => candidate.kind === "SO")
    .map((candidate) => candidate.id);
  assert.deepEqual(filteredSoIds, localIds,
    "Every retained SO candidate must have the same kind/id in the local source manifest.");
  assert.equal(filtered.some((candidate) => candidate.kind === "PO"), true,
    "DB-only SO filtering must not remove PO candidates.");
  assert.equal(filtered.some((candidate) => candidate.kind === "TO"), true,
    "DB-only SO filtering must not remove TO candidates.");
}

assert.equal(isNetSuiteSalesOrderBilled({ status: "G" }), true);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Billed" }), true);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Sales Order : Billed" }), true);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "sales order: billed" }), true);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Pending Billing" }), false);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Pending Billing/Partially Fulfilled" }), false);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Billed (closed)" }), false);
assert.equal(isNetSuiteSalesOrderBilled({ statusCode: " g " }), true);
assert.equal(isNetSuiteSalesOrderBilled({ status_text: " Sales Order:  Billed " }), true);
assert.equal(isNetSuiteSalesOrderBilled({ statusText: "Sales   Order :  Billed" }), true);
assert.equal(isNetSuiteSalesOrderBilled({ netsuiteStatusText: "Billed" }), true);
assert.equal(isNetSuiteSalesOrderBilled(), false);

for (const order of [
  { status: "H" },
  { statusText: "Closed" },
  { status_text: "Sales Order : Closed" },
  { netsuiteStatusText: " sales order:  closed " }
]) {
  assert.equal(isNetSuiteSalesOrderClosed(order), true, JSON.stringify(order));
}
for (const order of [
  {},
  { status: "G", statusText: "Sales Order : Billed" },
  { statusText: "Pending Fulfillment" },
  { statusText: "Not Closed Yet" }
]) {
  assert.equal(isNetSuiteSalesOrderClosed(order), false, JSON.stringify(order));
}

assert.deepEqual(deriveSalesOrderReconciliationState({
  closed: true,
  lines: [{ quantity: 100, cumulativeProgressQuantity: 40 }]
}), {
  applicationStatus: "Completed",
  fulfillmentStatus: "partial_fulfilled",
  quantities: {
    ordered: 100,
    fulfilled: 40,
    abandoned: 60,
    remaining: 0
  }
});

assert.deepEqual(deriveSalesOrderReconciliationState({
  closed: true,
  lines: [{ quantity: 100, cumulativeProgressQuantity: 0 }]
}), {
  applicationStatus: "Cancelled",
  fulfillmentStatus: "not_fulfilled",
  quantities: {
    ordered: 100,
    fulfilled: 0,
    abandoned: 100,
    remaining: 0
  }
});

assert.deepEqual(deriveSalesOrderReconciliationState({
  lines: [{ quantity: 100, cumulativeProgressQuantity: 40 }]
}), {
  applicationStatus: "Partially Done",
  fulfillmentStatus: "partial_fulfilled",
  quantities: {
    ordered: 100,
    fulfilled: 40,
    abandoned: 0,
    remaining: 60
  }
});

for (const statusText of [
  "Fulfilled",
  "Sales Order : Fulfilled",
  "Pending Billing",
  "Sales Order : Pending Billing",
  "Billed",
  "Sales Order : Billed"
]) {
  assert.equal(isNetSuiteSalesOrderFulfilled({ statusText }), true, statusText);
}
for (const statusText of [
  "Pending Fulfillment",
  "Partially Fulfilled",
  "Pending Billing / Partially Fulfilled",
  "Closed",
  "Cancelled"
]) {
  assert.equal(isNetSuiteSalesOrderFulfilled({ statusText }), false, statusText);
}

assert.equal(isSalesOrderInventoryLine({ itemType: "InvtPart", itemName: "BLOCK" }), true);
assert.equal(isSalesOrderInventoryLine({ itemType: "Assembly", itemName: "MBBS-Special" }), true);
assert.equal(isSalesOrderInventoryLine({ itemType: "Service", itemName: "Delivery Charge" }), false);
assert.equal(isSalesOrderInventoryLine({ itemType: "NonInvtPart", itemName: "Delivery Charge" }), false);
assert.equal(isSalesOrderInventoryLine({ itemType: "Charge", itemName: "Freight" }), false);
assert.equal(isSalesOrderInventoryLine({ item_type: "Inventory Item" }), true);
assert.equal(isSalesOrderInventoryLine({ itemTypeText: "Serialized Inventory Item" }), true);
assert.equal(isSalesOrderInventoryLine({ item_type_text: "Non-Inventory Item for Sale" }), false);
assert.equal(isSalesOrderInventoryLine(), false);

assert.deepEqual(
  mapNetSuiteSalesOrderLine({
    sourceLineKey: "9001",
    itemId: 25,
    itemName: "MBBS-Special",
    itemType: "Assembly",
    quantity: 1088,
    cumulativeProgressQuantity: 0,
    unit: "PCs",
    palletQty: 34,
    toPlt: 32
  }),
  {
    uniquekey: "9001",
    line_unique_key: "9001",
    line_id: "9001",
    item_id: 25,
    item_name: "MBBS-Special",
    item_type: "Assembly",
    item_type_text: "",
    item_description: "",
    sku: "MBBS-Special",
    quantity: 1088,
    netsuite_received_qty: 0,
    unit: "PCs",
    item_weight: null,
    location_id: null,
    location: "",
    pallet_qty: 0,
    layer_qty: 0,
    piece_qty: 0,
    section_qty: 0,
    to_plt: null,
    to_lyr: null,
    to_sec: null,
    to_pcs: null,
    pack_quantity_source: "sales_only",
    raw: {
      sourceLineKey: "9001",
      reconciliationStage: "outbound",
      authoritativeSalesQuantity: 1088,
      authoritativeSalesUom: "PCs"
    }
  },
  "SO reconciliation must use sales quantity/UOM instead of also materializing a duplicate 34-PLT demand."
);

const fallbackLine = mapNetSuiteSalesOrderLine({
  line_id: "9002",
  item_id: "26",
  item_name: "Fallback Item",
  item_type: "InvtPart",
  item_type_text: "Inventory Item",
  item_description: "Description",
  sku: "FALLBACK-SKU",
  quantity: "-1,088",
  quantityshiprecv: "32",
  unit: " PCs ",
  item_weight: 12.5,
  location_id: "15",
  location: "12441",
  raw: { retained: true }
});
assert.equal(fallbackLine.line_id, "9002");
assert.equal(fallbackLine.item_id, 26);
assert.equal(fallbackLine.quantity, 1088);
assert.equal(fallbackLine.netsuite_received_qty, 32);
assert.equal(fallbackLine.unit, "PCs");
assert.equal(fallbackLine.location_id, 15);
assert.equal(fallbackLine.raw.retained, true);

assert.equal(mapNetSuiteSalesOrderLine({ uniquekey: "9003", quantity: "invalid" }).quantity, 0);
assert.equal(mapNetSuiteSalesOrderLine({ line_unique_key: "9004", netsuite_received_qty: 2 }).line_id, "9004");
assert.equal(mapNetSuiteSalesOrderLine({ lineId: "9005", itemId: -1, raw: "ignored" }).item_id, null);
assert.throws(
  () => mapNetSuiteSalesOrderLine({ line_id: "unsafe-line" }),
  (error) => error?.code === "SO_RECONCILIATION_LINE_IDENTITY" && error?.status === 409
);
assert.throws(() => mapNetSuiteSalesOrderLine(), /safe unique Sales Order line key/);

const plan = {
  id: "plan-1",
  orders: [
    { id: "SOB116645", type: "SO" },
    { id: "SOB116645-S1", type: "SO", originalOrderId: "SOB116645" },
    { id: "SOB999999", type: "SO" }
  ],
  trucks: [{
    id: "truck-1",
    loads: [{
    id: "load-1",
      orders: ["SOB116645", { id: "SOB999999" }, null],
      stops: [
        { id: "pick-billed", type: "pick", orderId: "SOB116645", location: "12441" },
        { id: "drop-billed", type: "drop", orderId: "SOB116645-S1" },
        { id: "mixed-stop", type: "drop", orderRefs: ["SOB116645", "SOB999999"] },
        { id: "drop-other", type: "drop", orderId: "SOB999999" }
      ]
    }]
  }]
};

const scrubbed = scrubBilledSalesOrderFamilyFromPlan(plan, {
  canonicalRef: "SOB116645",
  familyRefs: ["SOB116645", "SOB116645-S1"]
});
assert.deepEqual(scrubbed.plan.orders.map((order) => order.id), ["SOB999999"]);
assert.deepEqual(
  scrubbed.plan.trucks[0].loads[0].stops.map((stop) => stop.id),
  ["mixed-stop", "drop-other"]
);
assert.deepEqual(scrubbed.plan.trucks[0].loads[0].stops[0].orderRefs, ["SOB999999"]);
assert.deepEqual(scrubbed.plan.trucks[0].loads[0].orders, [{ id: "SOB999999" }]);
assert.equal(scrubbed.changed, true);
assert.equal(scrubbed.deferred, false);

const deferred = scrubBilledSalesOrderFamilyFromPlan(plan, {
  canonicalRef: "SOB116645",
  familyRefs: ["SOB116645", "SOB116645-S1"],
  inProgressOrderRefs: ["SOB116645"]
});
assert.equal(deferred.deferred, true);
assert.equal(deferred.changed, false);
assert.deepEqual(deferred.plan, plan, "An in-progress driver route must be retained verbatim.");

const groupedPlan = {
  orders: [{
    id: "GOA-100-200",
    type: "SO",
    childOrders: ["SOA00100", "SOA00200"],
    childOrderDetails: [
      { id: "SOA00100", type: "SO", fulfillmentStatus: "fulfilled", pallets: 2, salesQty: 10 },
      { id: "SOA00200", type: "SO", fulfillmentStatus: "not_fulfilled", pallets: 3, salesQty: 20 }
    ],
    pallets: 5,
    salesQty: 30
  }],
  trucks: [{
    loads: [{
      id: "group-load",
      orders: ["GOA-100-200"],
      stops: [{ id: "group-stop", type: "drop", orderId: "GOA-100-200", orderRefs: ["GOA-100-200"] }]
    }]
  }]
};
const dissolvedGroup = scrubBilledSalesOrderFamilyFromPlan(groupedPlan, {
  familyRefs: ["SOA00100"]
});
assert.deepEqual(dissolvedGroup.plan.orders.map((order) => order.id), ["SOA00200"]);
assert.equal(dissolvedGroup.plan.orders[0].localDispatchStatus, "planned");
assert.deepEqual(
  dissolvedGroup.plan.trucks[0].loads[0].stops.map((stop) => stop.orderId),
  ["SOA00200"],
  "Removing one billed child must rewrite the group stop to the remaining real SO."
);
assert.deepEqual(dissolvedGroup.plan.trucks[0].loads[0].orders, ["SOA00200"]);

const threeChildGroup = {
  orders: [{
    id: "GOA-100-200-300",
    type: "SO",
    childOrders: ["SOA00100", "SOA00200", "SOA00300"],
    childOrderDetails: [
      { id: "SOA00100", type: "SO", pallets: 2, salesQty: 10 },
      { id: "SOA00200", type: "SO", pallets: 3, salesQty: 20 },
      { id: "SOA00300", type: "SO", pallets: 4, salesQty: 30 }
    ],
    pallets: 9,
    salesQty: 60
  }],
  trucks: [{ loads: [{ id: "three-load", stops: [{ id: "three-stop", type: "drop", orderId: "GOA-100-200-300" }] }] }]
};
const shrunkGroup = scrubBilledSalesOrderFamilyFromPlan(threeChildGroup, {
  familyRefs: ["SOA00100"]
});
assert.equal(shrunkGroup.plan.orders[0].id, "GOA-100-200-300",
  "A group with two children remaining must retain its stable dispatch identity.");
assert.deepEqual(shrunkGroup.plan.orders[0].childOrders, ["SOA00200", "SOA00300"]);
assert.equal(shrunkGroup.plan.orders[0].pallets, 7);
assert.equal(shrunkGroup.plan.orders[0].salesQty, 50);
assert.equal(shrunkGroup.plan.trucks[0].loads[0].stops[0].orderId, "GOA-100-200-300");

const removedWholeGroup = scrubBilledSalesOrderFamilyFromPlan(groupedPlan, {
  familyRefs: ["SOA00100", "SOA00200"]
});
assert.deepEqual(removedWholeGroup.plan.orders, []);
assert.deepEqual(removedWholeGroup.plan.trucks[0].loads[0].orders, []);
assert.deepEqual(removedWholeGroup.plan.trucks[0].loads[0].stops, []);

for (let childCount = 2; childCount <= 12; childCount += 1) {
  for (let completedCount = 0; completedCount <= childCount; completedCount += 1) {
    const children = Array.from({ length: childCount }, (_, index) => ({
      id: `SO-PROPERTY-${childCount}-${index}`,
      type: "SO",
      fulfillmentStatus: index < completedCount ? "fulfilled" : "not_fulfilled",
      pallets: index + 1,
      salesQty: (index + 1) * 10
    }));
    const rolled = rollupGroupedSalesOrderReconciliation({
      id: `GO-PROPERTY-${childCount}-${completedCount}`,
      type: "SO"
    }, children);
    const expected = completedCount === childCount
      ? "Completed"
      : completedCount > 0
        ? "Partially Done"
        : "Queued";
    assert.equal(rolled.reconciliationApplicationStatus, expected,
      "Grouped SO rollup must be determined by every active child, independent of group size.");
    assert.equal(rolled.pallets, childCount * (childCount + 1) / 2);
    assert.equal(rolled.salesQty, childCount * (childCount + 1) * 5);
  }
}

const reviewPrecedence = rollupGroupedSalesOrderReconciliation({
  id: "GO-REVIEW-PRECEDENCE",
  type: "SO"
}, [
  { id: "SO-COMPLETE", fulfillmentStatus: "fulfilled" },
  {
    id: "SO-REVIEW",
    fulfillmentStatus: "fulfilled",
    reconciliationStatus: "review",
    reconciliationReason: "Review wins."
  }
]);
assert.equal(reviewPrecedence.reconciliationApplicationStatus, "Reconcile Review");
assert.equal(reviewPrecedence.reconciliationReason, "Review wins.");

const emptyFamily = scrubBilledSalesOrderFamilyFromPlan({ orders: [], trucks: [] });
assert.equal(emptyFamily.changed, false);
assert.equal(emptyFamily.deferred, false);

const unchanged = scrubBilledSalesOrderFamilyFromPlan({
  orders: [{ tranid: "SOB999999" }],
  trucks: [{ loads: [{ id: "empty-load" }] }]
}, { familyRefs: ["SOB116645"] });
assert.equal(unchanged.changed, false);
assert.equal(unchanged.plan.orders[0].tranid, "SOB999999");

const alternateRefs = scrubBilledSalesOrderFamilyFromPlan({
  orders: [
    { order_id: "SOB116645" },
    { orderRef: "SOB116645" },
    { order_ref: "SOB116645" },
    { sourceOrderId: "SOB116645" },
    { source_order_id: "SOB116645" },
    { original_order_id: "SOB116645" },
    { order_refs: ["SOB116645"] },
    { childOrders: ["SOB116645-S1"] },
    12345,
    "SOB116645-S1"
  ],
  trucks: []
}, { familyRefs: ["SOB116645", "SOB116645-S1", "12345"] });
assert.deepEqual(alternateRefs.plan.orders, []);

console.log("Sales-order reconciliation harness passed.");

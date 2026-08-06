import assert from "node:assert/strict";
import {
  filterDbBackedSalesOrderReconciliationCandidates,
  isNetSuiteSalesOrderBilled,
  isSalesOrderInventoryLine,
  mapNetSuiteSalesOrderLine,
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

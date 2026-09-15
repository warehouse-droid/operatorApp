import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { comparableAllocationPlans } from "../../../src/dispatch-allocation-item-identity.js";
import { changedLockedLoadAssignments } from "../../../src/dispatch-load-assignment.js";
import { liveRoutePlan, activeDropRecord } from "../../support/driver-live-route-prefix-lock-fixture.mjs";
import { netsuiteCargoReader, soLines } from "../../support/sales-order-cargo-fixture.mjs";

for (const mode of ["single", "batch"]) {
  test(`SO-01 ${mode} sync retains SOB119965 fulfilled lines and ordered cargo`, async () => {
    const reader = netsuiteCargoReader();
    const rows = mode === "single"
      ? await reader.fetchDeliveryOrderDetailsFromNetSuite(986406)
      : (await reader.fetchDeliveryOrderDetailsBatchFromNetSuite([986406])).get(986406);
    assert.deepEqual(rows.map((line) => [line.line_id, line.item_id, line.quantity]),
      soLines.map((line) => [line.line_id, line.item_id, Number(line.quantity)]));
    assert.equal(rows[0].pallet_qty, 8);
    assert.equal(rows[1].layer_qty, 5);
    assert.equal(rows[2].quantity, 37);
  });
}

test("SO-02 every SO lookup omits fulfillment subtraction while other order filters survive", async () => {
  const reader = netsuiteCargoReader();
  await reader.fetchDeliveryOrdersFromNetSuite(1);
  await reader.fetchSovPendingFulfillmentOrdersFromNetSuite();
  await reader.fetchDeliveryOrderFromNetSuite(986406, 1);
  await reader.fetchCustomerPickupOrderFromNetSuite("SOB119965", 1);
  for (const sql of reader.queries) {
    assert.doesNotMatch(sql, /quantityshiprecv/u);
    assert.match(sql, /t\.type = 'SalesOrd'/u);
    assert.match(sql, /tl\.mainline = 'F'/u);
  }
  assert.match(reader.queries[0], /Partially Fulfilled/u);
  assert.match(reader.queries[0], /tl\.location = 1/u);
  assert.match(reader.queries[0], /NOT LIKE 'SOT%'/u);
  assert.match(reader.queries[1], /LIKE 'SOV%'/u);
  assert.match(reader.queries[3], /'Pick-Up'/u);
  assert.match(reader.purchaseOrderListQuery(1), /quantityshiprecv/u);
  assert.match(reader.transferOrderListQuery({ statusText: "Pending Fulfillment" }), /quantityshiprecv/u);
});

test("SO-01 ordered quantity and manual packs are invariant to fulfillment progress", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 12000 }), async (ordered, fulfilled) => {
    const reader = netsuiteCargoReader([{ ...soLines[0], quantity: ordered, netsuite_received_qty: fulfilled }]);
    const rows = await reader.fetchDeliveryOrderDetailsFromNetSuite(986406);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, ordered);
    assert.equal(rows[0].pallet_qty, 8);
  }), { seed: 20260911, numRuns: 150 });
});

test("ID-01 compact cards preserve stable item and line identities", () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ itemId: 1158 + index, lineRowId: 400 + index, lineId: 4919454 + index, sku: `STONE-${index}`, quantity: 28 }));
  const card = compactDispatchOrderCard({ id: "SOB119854", type: "SO", items });
  assert.equal(card.items.length, 8);
  assert.equal(card.itemCount, 12);
  assert.equal(card.catalogHydrated, false);
  assert.deepEqual(card.items, items.slice(0, 8));
});

function allocationPlans() {
  const previousPlan = liveRoutePlan();
  const child = { id: "SOB119854", items: [{ sku: "UNI-SIES-STD375-GN", lineId: 4919454, quantity: 28, pallets: 3, unit: "pcs" }] };
  previousPlan.orders[1] = { ...previousPlan.orders[1], items: structuredClone(child.items), childOrders: [child.id], childOrderDetails: [child] };
  const nextPlan = structuredClone(previousPlan);
  nextPlan.orders[1].items[0].itemId = 1158;
  nextPlan.orders[1].childOrderDetails[0].items[0].itemId = 1158;
  return { previousPlan, nextPlan };
}

test("ID-02 legacy grouped item ID enrichment does not change executed allocation", () => {
  const plans = allocationPlans();
  const before = structuredClone(plans);
  assert.deepEqual(evaluateExecutedPrefixPolicy({ ...plans, activity: [activeDropRecord()] }), { allowed: true, conflicts: [] });
  assert.deepEqual(plans, before, "comparison must not mutate either plan");
});

test("ID-02 real item, amount and child allocation changes remain protected", () => {
  for (const mutation of [
    (p) => { p.nextPlan.orders[1].items[0].quantity += 1; },
    (p) => { p.previousPlan.orders[1].items[0].itemId = 9999; },
    (p) => { p.nextPlan.orders[1].childOrderDetails[0].items[0].quantity += 1; },
    (p) => { p.nextPlan.orders[1].items.push({ ...p.nextPlan.orders[1].items[0], itemId: 9999, quantity: 0, pallets: 0 }); },
    (p) => { p.nextPlan.orders[1].items[0].sku = "DIFFERENT-STONE"; }
  ]) {
    const plans = allocationPlans();
    mutation(plans);
    assert.equal(evaluateExecutedPrefixPolicy({ ...plans, activity: [activeDropRecord()] }).allowed, false);
  }
});

test("ID-02 enrichment is symmetric and changed quantities are always rejected", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 1000 }), (quantity, delta) => {
    const plans = allocationPlans();
    for (const plan of Object.values(plans)) {
      plan.orders[1].items[0].quantity = quantity;
      plan.orders[1].childOrderDetails[0].items[0].quantity = quantity;
    }
    assert.equal(evaluateExecutedPrefixPolicy({ ...plans, activity: [activeDropRecord()] }).allowed, true);
    assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: plans.nextPlan, nextPlan: plans.previousPlan, activity: [activeDropRecord()] }).allowed, true);
    plans.nextPlan.orders[1].items[0].quantity += delta;
    assert.equal(evaluateExecutedPrefixPolicy({ ...plans, activity: [activeDropRecord()] }).allowed, false);
  }), { seed: 20260912, numRuns: 150 });
});

test("ID-02 ID evidence is scoped to an order and ambiguous SKUs stay unresolved", () => {
  const previous = { orders: [{ id: "A", items: [{ sku: "STONE", quantity: 28 }] }], trucks: [] };
  const next = { orders: [{ id: "A", items: [{ sku: "STONE", itemId: 1 }, { sku: "STONE", itemId: 2 }] }], trucks: [] };
  assert.equal(comparableAllocationPlans(previous, next)[0].orders[0].items[0].itemId, undefined);
  next.orders[0].id = "B";
  next.orders[0].items.pop();
  assert.equal(comparableAllocationPlans(previous, next)[0].orders[0].items[0].itemId, undefined);
  assert.deepEqual(comparableAllocationPlans({}, {}), [{}, {}]);
  assert.deepEqual(comparableAllocationPlans({ orders: [null, { items: [] }] }, {}), [{ orders: [null, { items: [] }] }, {}]);
});

test("ID-02 preceding-load comparisons accept IDs and still protect array-scoped locks", () => {
  const { previousPlan, nextPlan } = allocationPlans();
  assert.deepEqual(changedLockedLoadAssignments(previousPlan, nextPlan, ["load-2-active"]), []);
  nextPlan.orders[1].items[0].quantity += 1;
  assert.equal(changedLockedLoadAssignments(previousPlan, nextPlan, ["load-2-active"]).length, 1);
  assert.deepEqual(changedLockedLoadAssignments(previousPlan, nextPlan, []), []);
});

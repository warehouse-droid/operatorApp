import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { incidentOrders, retiredConfirmBrowser } from "../../support/retired-confirm-fixture.mjs";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

const plan = (orders, trucks = []) => ({ id: "324", planDate: "2026-09-14", revision: 19, orders, trucks });
const assigned = id => [{ id: "T1", loads: [{ id: "L1", stops: [{ id: "stop1", type: "drop", orderId: id }] }] }];

for (const order of incidentOrders()) {
  test(`recovery payload excludes incidental unassigned ${order.id}`, () => {
    const input = plan([order]);
    const before = structuredClone(input);
    assert.deepEqual(retiredConfirmBrowser(input).planPayload().orders, []);
    assert.deepEqual(input, before);
  });
  test(`assigned ${order.id} remains visible to the strict server validator`, () => {
    const input = plan([order], assigned(order.id));
    const payload = retiredConfirmBrowser(input).planPayload();
    assert.deepEqual(payload.orders.map(row => row.id), [order.id]);
    assert.deepEqual(payload.trucks, input.trucks);
  });
}

test("current-plan definitions, new groups, legacy unsaved splits and source transit edits are retained", () => {
  const orders = [
    { id: "SOM06255-S1", type: "SO", sourceTable: "sales_orders", originalOrderId: "SOM06255", raw: { tranid: "SOM06255" } },
    { id: "GOM-6255S2-6256S1", type: "SO", sourceTable: "sales_orders", planOwned: true, groupPlanId: "324", childOrders: ["SOM06255-S2", "SOM06256-S1"] },
    { id: "SO-OWN-S1", type: "SO", sourceTable: "sales_orders", globalOrderDefinition: true, globalOrderSourcePlanId: "324", globalOrderSourcePlanDate: "2026-09-14" },
    { id: "SO-TRANSIT", type: "SO", sourceTable: "sales_orders", raw: { tranid: "SO-TRANSIT" }, transitCo: { id: "CO-SO-TRANSIT" } }
  ];
  assert.deepEqual(retiredConfirmBrowser(plan(orders)).planPayload().orders.map(row => row.id), orders.map(row => row.id));
});

test("new split creation records local ownership even without raw source metadata", () => {
  const orders = [{ id: "SO-NEW", type: "SO", sourceTable: "sales_orders", pallets: 2, salesQty: 2, items: [{ quantity: 2 }] }];
  const browser = cargoFunctions("../../public/dispatch.js", ["splitOrder"], {
    orders, orderById: id => orders.find(row => row.id === id),
    splitTotalsForPart: () => ({ pallets: 1, salesQty: 1, weight: 1, items: [{ quantity: 1 }] }),
    selectedOrderId: "", selectedOrderIds: new Set(), activeOrderType: "SO"
  });
  browser.splitOrder("SO-NEW");
  assert.deepEqual(orders.map(row => row.planOwned), [true, true]);
  assert.deepEqual(retiredConfirmBrowser(plan(orders)).planPayload().orders.map(row => row.id), ["SO-NEW-S1", "SO-NEW-S2"]);
});

test("assigned canonical orders referenced by pickup orderRefs or orderRef remain in the save payload", () => {
  const orders = incidentOrders();
  const trucks = [{ id: "T1", loads: [{ id: "L1", stops: [
    { id: "pickup1", type: "pickup", orderRefs: [orders[0].id] },
    { id: "drop1", type: "drop", orderRef: orders[1].id }
  ] }] }];
  assert.deepEqual(retiredConfirmBrowser(plan(orders, trucks)).planPayload().orders.map(order => order.id), orders.map(order => order.id));
});

test("an incidental direct CO cannot hide an assigned source SO from the payload", () => {
  const co = incidentOrders()[1];
  const source = { id: "SOA07894", type: "SO", sourceTable: "sales_orders", items: [{ quantity: 4 }] };
  const input = plan([co, source], assigned(source.id));
  const payload = retiredConfirmBrowser(input).planPayload();
  assert.deepEqual(payload.orders.map(order => order.id), [source.id]);
  assert.deepEqual(payload.orders[0].items, source.items);
});

test("direct CO cargo references do not rewrite SO stops or hide independently assigned SOs", () => {
  const co = incidentOrders()[1];
  const source = { id: "SOA07894", type: "SO", sourceTable: "sales_orders" };
  const input = plan([co, source], assigned(source.id));
  const browser = cargoFunctions("../../public/dispatch.js", ["collapseGroupedOrderStops", "dispatchGroupingRefs",
    "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"], {
    orders: input.orders, trucks: input.trucks, isScmGroupedPoOrder: () => false, stopHasDriverActivity: () => false
  });
  const before = structuredClone(input.trucks);
  browser.collapseGroupedOrderStops();
  assert.deepEqual(input.trucks, before);
  input.trucks[0].loads[0].stops.push({ id: "co-drop", type: "drop", orderId: co.id });
  assert.deepEqual(retiredConfirmBrowser(input).planPayload().orders.map(order => order.id), [co.id, source.id]);
});

test("genuine aggregate CO groups still collapse their CO member stops", () => {
  const co = { id: "CO-GROUP", type: "CO", childOrders: ["CO-SO-A", "CO-SO-B"], planOwned: true };
  const input = plan([co], assigned("CO-SO-A"));
  const browser = cargoFunctions("../../public/dispatch.js", ["collapseGroupedOrderStops", "dispatchGroupingRefs",
    "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"], {
    orders: input.orders, trucks: input.trucks, isScmGroupedPoOrder: () => false, stopHasDriverActivity: () => false
  });
  browser.collapseGroupedOrderStops();
  assert.equal(input.trucks[0].loads[0].stops[0].orderId, co.id);
  assert.deepEqual(retiredConfirmBrowser(input).planPayload().orders.map(order => order.id), [co.id]);
});

test("property: canonical pool visibility never creates plan ownership, but assignment and local intent are retained", () => {
  const input = plan([]);
  const browser = retiredConfirmBrowser(input);
  fc.assert(fc.property(fc.array(fc.record({
    co: fc.boolean(), assigned: fc.boolean(), owned: fc.boolean(), raw: fc.boolean(), lower: fc.boolean()
  }), { minLength: 1, maxLength: 30 }), cases => {
    const orders = cases.map((entry, index) => {
      const id = `${entry.co ? "CO-SO" : "SO"}-${index}-S2`;
      return { id, type: entry.co ? "CO" : "SO", sourceTable: entry.co ? "local_co_orders" : "sales_orders",
        originalOrderId: entry.co ? "" : `SO-${index}`, planOwned: entry.owned,
        ...(entry.raw ? { raw: { tranid: entry.lower ? id.toLowerCase() : id } } : {}) };
    });
    const trucks = [{ id: "T1", loads: [{ id: "L1", stops: orders.flatMap((order, index) =>
      cases[index].assigned ? [{ id: `stop-${index}`, type: "drop", orderId: order.id }] : []) }] }];
    input.orders.splice(0, input.orders.length, ...orders);
    input.trucks = trucks;
    const frozen = structuredClone(input);
    const actual = browser.planPayload().orders.map(order => order.id);
    assert.deepEqual(actual, orders.filter((_, index) => cases[index].assigned || cases[index].owned).map(order => order.id));
    assert.deepEqual(input, frozen);
  }), { seed: 20260914, numRuns: 200 });
});

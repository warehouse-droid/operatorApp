import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { buildExecutedOrderReviews, reviewedExecutionComparison } from "../../../src/dispatch-executed-order-review.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import "../../../public/dispatch-address-guard.js";

const runs = { numRuns: 120, seed: 2092026 };
function scenario(before, after) {
  const order = { id: "TO-PROPERTY", type: "TO", address: "1 Recorded Road", items: [{ lineId: 1, itemId: 15, sku: "Material", quantity: before, unit: "EACH", pallets: 1 }] };
  const previousPlan = { id: "77", orders: [order], trucks: [{ id: "t", plate: "PROPERTY", loads: [{ id: "l", name: "Load 1", driverLogin: "driver",
    truckId: "t", truckPlate: "PROPERTY", stops: [{ id: "s", type: "drop", orderId: order.id }] }] }] };
  const source = structuredClone(order); source.items[0].quantity = after;
  const activity = [{ status: "complete", load_id: "l", stop_id: "s", stop_type: "drop" }];
  const reviews = buildExecutedOrderReviews({ previousPlan, sourceOrders: [source], activity });
  return { previousPlan, nextPlan: { ...structuredClone(previousPlan), orders: [structuredClone(source)] }, activity, reviews };
}
test("any genuine source quantity update can save without acknowledgement; another quantity cannot", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (before, after) => {
    const f = scenario(before, after);
    assert.equal(f.reviews.length, before === after ? 0 : 1);
    const comparison = reviewedExecutionComparison(f);
    assert.equal(evaluateExecutedPrefixPolicy({ ...f, previousPlan: comparison }).allowed, true);
    f.nextPlan.orders[0].items[0].quantity = Math.max(before, after) + 1;
    assert.equal(evaluateExecutedPrefixPolicy({ ...f, previousPlan: reviewedExecutionComparison(f) }).allowed, false);
  }), runs);
});

test("source matching cannot approve a forged item identity or delivery destination", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 100, max: 100000 }), (quantity, itemId) => {
    const f = scenario(quantity, quantity + 1);
    f.nextPlan.orders[0].items[0].itemId = itemId;
    assert.equal(evaluateExecutedPrefixPolicy({ ...f, previousPlan: reviewedExecutionComparison(f) }).allowed, false);
    f.nextPlan.orders[0].items[0].itemId = 15;
    f.nextPlan.orders[0].items[0].destinationYard = "FORGED-DESTINATION";
    assert.equal(evaluateExecutedPrefixPolicy({ ...f, previousPlan: reviewedExecutionComparison(f) }).allowed, false);
  }), runs);
});

test("blank refresh is immutable, recursively lossless and idempotent", () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }).filter(value => value.trim().length > 0), fc.constantFrom("", " ", "\t\n"), (address, blank) => {
    const previous = { id: "GROUP", address, childOrderDetails: [{ id: "SO", address }] };
    const next = { id: "GROUP", address: blank, childOrderDetails: [{ id: "SO", address: blank }] };
    const copy = structuredClone(next);
    const once = globalThis.DispatchAddressGuard.preserve(previous, next);
    assert.equal(once.order.address, address);
    assert.equal(once.order.childOrderDetails[0].address, address);
    assert.deepEqual(globalThis.DispatchAddressGuard.preserve(previous, once.order).order, once.order);
    assert.deepEqual(next, copy);
  }), runs);
});

test("future additions and source item presentation order cannot alter the review token", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), quantity => {
    const f = scenario(quantity, quantity + 1);
    f.previousPlan.orders[0].items.push({ lineId: 2, itemId: 20, sku: "second", quantity: 1 });
    f.nextPlan.orders[0].items.push({ lineId: 2, itemId: 20, sku: "second", quantity: 1 });
    const input = { ...f, sourceOrders: f.nextPlan.orders };
    const token = buildExecutedOrderReviews(input)[0].token;
    f.nextPlan.orders[0].items.reverse();
    f.previousPlan.trucks[0].loads.push({ id: "future", driverLogin: "driver", driverSequence: 99, stops: [] });
    assert.equal(buildExecutedOrderReviews(input)[0].token, token);
  }), runs);
});

test("every different source quantity requires a different review version", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), quantity => {
    assert.notEqual(scenario(quantity, quantity + 1).reviews[0].token, scenario(quantity, quantity + 2).reviews[0].token);
  }), runs);
});

import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { buildPlannedOrderReviews, buildExecutedOrderReviews, reconcileExecutedSourcePlan } from "../../../src/dispatch-executed-order-review.js";

test("planned source notices follow physical assignment and execution without changing either source", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 100 }),
    fc.constantFrom("unassigned", "planned", "picked", "delivered"), (quantity, increase, stage) => {
      const order = { id: "SO-PLANNED-PROPERTY", type: "SO", items: [{ lineId: 7, itemId: 12, sku: "CARGO", unit: "PC", quantity }] };
      const source = { ...order, items: [{ ...order.items[0], quantity: quantity + increase }] };
      const plan = { id: "test", orders: [order], trucks: [{ id: "T1", plate: "TEST", loads: stage === "unassigned" ? [] : [{
        id: "L1", driverLogin: "driver", driverName: "Driver", truckId: "T1", truckPlate: "TEST",
        stops: [{ id: "pick", type: "pick", orderId: order.id }, { id: "drop", type: "drop", orderId: order.id }]
      }] }] };
      const activity = ["picked", "delivered"].includes(stage)
        ? [{ status: "complete", load_id: "L1", stop_id: stage === "picked" ? "pick" : "drop", stop_type: stage === "picked" ? "pick" : "drop" }]
        : [];
      const input = { previousPlan: plan, sourceOrders: [source], activity };
      const original = structuredClone(input);
      const notices = buildPlannedOrderReviews(input);
      assert.equal(notices.length, stage === "unassigned" ? 0 : 1);
      if (notices.length) {
        assert.equal(notices[0].replanRequested, stage !== "delivered");
        assert.deepEqual(notices[0].changes.map(change => [change.field, change.before, change.after]), [["quantity", quantity, quantity + increase]]);
        assert.equal(buildPlannedOrderReviews(input)[0].token, notices[0].token);
      }
      const reviews = buildExecutedOrderReviews(input);
      assert.equal(reviews.length, ["picked", "delivered"].includes(stage) ? 1 : 0);
      const reconciled = reconcileExecutedSourcePlan({ previousPlan: plan, nextPlan: { ...plan, orders: [source] }, reviews });
      assert.equal(reconciled.orders[0].items[0].quantity, reviews.length ? quantity : quantity + increase);
      assert.deepEqual(input, original);
    }), { seed: 28092026, numRuns: 80 });
});

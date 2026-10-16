import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { applyDispatchSourceOrders, dispatchSourceChangePredatesWork, dispatchSourceReceiptMatchesOrder } from "../../../src/dispatch-executed-order-review.js";

test("only a proven server application time before every affected job allows automatic acceptance", () => {
  const review = { sourceAppliedAt: "2026-10-06T13:38:21Z", contexts: [{ loadId: "affected" }] };
  const row = { load_id: "affected", status: "in_progress", started_at: "2026-10-07T14:31:49Z" };
  assert.equal(dispatchSourceChangePredatesWork(review, [row]), true);
  assert.equal(dispatchSourceChangePredatesWork({ ...review, sourceAppliedAt: row.started_at }, [row]), false);
  assert.equal(dispatchSourceChangePredatesWork({ ...review, sourceAppliedAt: "2026-10-08T13:00:00Z" }, [row]), false);
  assert.equal(dispatchSourceChangePredatesWork({ contexts: review.contexts }, [row]), false);
  assert.equal(dispatchSourceChangePredatesWork(review, [{ ...row, started_at: "bad" }]), false);
  assert.equal(dispatchSourceChangePredatesWork(review, [{ ...row, load_id: "other" }]), true);
  assert.equal(dispatchSourceChangePredatesWork(review, []), true);
});

test("property: consolidation preserves cargo sums, siblings and the route and is idempotent", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 500 }), (a, b, siblingQuantity) => {
    const child = { id: "SOA09704", salesQty: a + b, pallets: 2, items: [{ lineId: 1, quantity: a }, { lineId: 2, quantity: b }] };
    const sibling = { id: "SOA09731", salesQty: siblingQuantity, pallets: 0, items: [{ lineId: 3, quantity: siblingQuantity }] };
    const group = { id: "GOA-9704-9731", salesQty: a + b + siblingQuantity, pallets: 2, items: [...child.items, ...sibling.items], childOrderDetails: [child, sibling] };
    const plan = { orders: [group, { id: "UNRELATED", items: [{ quantity: 999 }] }], trucks: [{ loads: [{ id: "fixed", stops: [{ id: "fixed-stop", timing: { arrival: 600 } }] }] }] };
    const source = { ...child, pallets: 1, items: [{ lineId: 1, quantity: a + b }] };
    const before = structuredClone(plan);
    const next = applyDispatchSourceOrders(plan, [source], [child.id]);
    assert.equal(next.orders[0].salesQty, a + b + siblingQuantity);
    assert.equal(next.orders[0].pallets, 1);
    assert.equal(next.orders[0].items.length, 2);
    assert.deepEqual(next.orders[0].childOrderDetails[1], sibling);
    assert.deepEqual(next.trucks, plan.trucks);
    assert.deepEqual(next.orders[1], plan.orders[1]);
    assert.deepEqual(applyDispatchSourceOrders(next, [source], [child.id]), next);
    assert.deepEqual(plan, before);
  }), { seed: 271290704, numRuns: 150 });
});

test("accepting an address change retains sibling addresses and the recorded stop", () => {
  const first = { id: "FIRST", address: "Old address", items: [] };
  const sibling = { id: "SIBLING", address: "Sibling address", items: [] };
  const plan = { orders: [{ id: "GROUP", address: first.address, childOrderDetails: [first, sibling] }], trucks: [{ loads: [{ stops: [{ address: first.address }] }] }] };
  const next = applyDispatchSourceOrders(plan, [{ ...first, address: "New address" }], [first.id]);
  assert.equal(next.orders[0].address, "New address");
  assert.equal(next.orders[0].childOrderDetails[1].address, "Sibling address");
  assert.deepEqual(next.trucks, plan.trucks);
});

test("only matching line identities, quantities and units establish a current source receipt", () => {
  const order = { items: [{ lineId: 1, itemId: 1189, quantity: 110, unit: "PC" }] };
  const changes = [{ field: "item_removed" }, { field: "salesQty" }];
  assert.equal(dispatchSourceReceiptMatchesOrder(order, { lines: order.items }, changes), true);
  assert.equal(dispatchSourceReceiptMatchesOrder(order, {}, changes), false);
  assert.equal(dispatchSourceReceiptMatchesOrder(order, { lines: [{ ...order.items[0], quantity: 111 }] }, changes), false);
  assert.equal(dispatchSourceReceiptMatchesOrder(order, { lines: order.items }, [{ field: "address" }]), false);
});

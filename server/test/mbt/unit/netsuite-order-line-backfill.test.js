import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { selectIncompleteNetSuiteOrders, planNetSuiteOrderLineBackfill } from "../../../src/netsuite-order-line-backfill.js";

const local = (extra = {}) => ({ id: 12, order_id: 99, line_id: 9876, item_id: 42, netsuite_order_line: null,
  netsuite_active: true, netsuite_order_line_synced_at: null, synced_at: "2026-09-16 12:00:00.123456+00", ...extra });
const remote = (extra = {}) => ({ order_id: 99, line_id: 9876, item_id: 42, netsuite_order_line: 4, ...extra });

test("incomplete discovery includes approvals and partial states, excludes fulfilled/billed/closed and SOT policy", () => {
  const types = ["SalesOrd", "PurchOrd", "TrnfrOrd"];
  const statuses = ["Pending Approval", "Pending Fulfillment", "Partially Fulfilled", "Pending Billing/Partially Fulfilled",
    "Pending Receipt", "Partially Received", "Pending Billing/Partially Received", "Pending Billing", "Pending Bill", "Billed", "Closed", "Received", "Cancelled"];
  const rows = types.flatMap((type, index) => statuses.map((status, i) => ({ id: index * 100 + i + 1, type,
    tranid: `${["SO", "PO", "TO"][index]}BTEST${i}`, status_text: `${type} : ${status}` })));
  const selected = selectIncompleteNetSuiteOrders([...rows, { id: 999, type: "SalesOrd", tranid: "SOT999", status_text: "Pending Fulfillment" }]);
  assert.equal(selected.length, 21);
  assert.ok(selected.every(row => row.kind && !row.tranid.startsWith("SOT")));
  assert.deepEqual(selectIncompleteNetSuiteOrders([{ id: -1, type: "SalesOrd", tranid: "SO1", status_text: "Pending Fulfillment" }]), []);
});

test("backfill requires exact source, stable key, item, and an unambiguous explicit mapping", () => {
  const plan = planNetSuiteOrderLineBackfill([local(), local({ id: 13, line_id: 999 })], [remote()]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].netsuite_order_line, 4);
  assert.equal(plan.updates[0].expected_synced_at, local().synced_at);
  assert.equal(plan.unresolved.length, 1);
  for (const rows of [[remote({ order_id: 100 })], [remote({ item_id: 43 })], [remote({ netsuite_order_line: null })],
    [remote(), remote({ netsuite_order_line: 17 })], [remote({ netsuite_order_line: 0 })]]) {
    const rejected = planNetSuiteOrderLineBackfill([local()], rows);
    assert.equal(rejected.updates.length, 0);
    assert.equal(rejected.unresolved.length, 1);
  }
  const unchanged = planNetSuiteOrderLineBackfill([local({ netsuite_order_line: "4" })], [remote()]);
  assert.equal(unchanged.unchanged.length, 1);
  assert.equal(unchanged.updates.length, 0);
  const inactive = planNetSuiteOrderLineBackfill([local({ netsuite_active: false })], [remote()]);
  assert.equal(inactive.updates[0].expected_active, false);
  const historical = planNetSuiteOrderLineBackfill([local({ netsuite_active: false })], []);
  assert.equal(historical.excluded[0].reason, "inactive_historical_line");
  assert.equal(historical.unresolved.length, 0);
  assert.equal(planNetSuiteOrderLineBackfill([local({ netsuite_active: false })], [remote({ item_id: 43 })]).unresolved.length, 1);
});

test("property: backfill matches keys independently of row order, repeated items, or existing progress", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 1000000 }), { minLength: 1, maxLength: 20 }), keys => {
    const locals = keys.map((key, index) => local({ id: index + 1, line_id: key, packed_piece_qty: index + 8 }));
    const remotes = keys.map((key, index) => remote({ line_id: key, netsuite_order_line: index * 3 + 1 })).reverse();
    const snapshot = structuredClone(locals);
    const plan = planNetSuiteOrderLineBackfill(locals, remotes);
    assert.equal(plan.updates.length, keys.length);
    plan.updates.forEach((row, index) => assert.equal(row.netsuite_order_line, index * 3 + 1));
    assert.deepEqual(locals, snapshot);
    assert.equal(planNetSuiteOrderLineBackfill(locals, remotes.map(row => ({ ...row, item_id: 43 }))).updates.length, 0);
    assert.equal(planNetSuiteOrderLineBackfill(locals, remotes.map(row => ({ ...row, order_id: 100 }))).updates.length, 0);
  }), { seed: 1400333, numRuns: 200 });
});

test("backfill reports subtotal rows separately without hiding missing inventory identities", () => {
  const subtotal = local({ item_id: -2, item_type: null });
  const plan = planNetSuiteOrderLineBackfill([subtotal, local({ id: 13, item_id: null, item_type: "Subtotal" }),
    local({ id: 14, item_id: null, item_type: "InvtPart" })], []);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.excluded.length, 2);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].id, 14);
});

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { verifiedPoReceiptTotals } from "../../../src/receiving-receipt-progress.js";

function receipt(id, baseline, quantity, authoritative = false, changes = {}) {
  return { netsuite_transaction_id: id, payload: { item: { items: [{ orderLine: 25, itemReceive: true, quantity }] } },
    reconciliation: [{ sourceOrderKind: "PO", sourceNetSuiteId: 939701, sourceLineKey: "4851527", orderLine: 25,
      completedQuantity: baseline, authoritative, ...changes }] };
}

test("verified receipt totals accumulate stale direct counters and overlap refreshed authoritative totals", () => {
  const rows = [receipt(1, 504, 100), receipt(2, 504, 100), receipt(3, 704, 50, true), receipt(4, 504, 38)];
  assert.equal(verifiedPoReceiptTotals(939701, rows).get("4851527"), 792);
  assert.equal(verifiedPoReceiptTotals(939701, [...rows, rows[3]]).get("4851527"), 792);
});

test("wrong source identities, deselections and missing quantities cannot retire a parent line", () => {
  const wrongSource = receipt(1, 999, 1, false, { sourceNetSuiteId: 123 });
  const wrongKind = receipt(2, 999, 1, false, { sourceOrderKind: "TO" });
  const missingKey = receipt(3, 999, 1, false, { sourceLineKey: "" });
  const deselected = receipt(4, 999, 1); deselected.payload.item.items[0].itemReceive = false;
  const missingPayload = receipt(5, 999, 1); missingPayload.payload.item.items = [];
  assert.deepEqual([...verifiedPoReceiptTotals(939701, [wrongSource, wrongKind, missingKey, deselected, missingPayload, receipt(6, 999, -1)])], []);
});

test("property: repeated receipts and lagging caches cannot change the sum of distinct verified postings", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 15 }), (baseline, amounts) => {
    const receipts = amounts.map((amount, index) => receipt(index + 1, baseline, amount));
    const expected = baseline + amounts.reduce((sum, amount) => sum + amount, 0);
    assert.equal(verifiedPoReceiptTotals(939701, receipts.flatMap(row => [row, row])).get("4851527"), expected);
  }), { seed: 1400625, numRuns: 100 });
});

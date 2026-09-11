import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { allocateScmReceiptRowsBySplitReference, resolveScmReceiptSplitReference } from "../../../src/scm-ir-split-reference.js";

const child = { targetKind: "po_split", targetOrderRef: "SN1399025", requestedQty: 60 };
const residual = {
  targetKind: "source_residual", targetOrderRef: "SN1399744", isParent: true,
  receiptReferenceAliases: ["SN1399744"], requestedQty: 40
};

test("a receipt names the source's explicitly configured residual dispatch reference", () => {
  const result = allocateScmReceiptRowsBySplitReference({
    targets: [child, residual], totalReceivedQty: 100,
    receiptRows: [{ transactionMemo: "SN1399025", quantity: 60 }, { transactionMemo: "sn 1399744 (for pallet)", quantity: 40 }]
  });
  assert.deepEqual(result.allocations, [60, 40]);
  assert.equal(result.referenceOverflowQty, 0);
  assert.equal(result.remainingTotalQty, 0);
  assert.deepEqual(result.unexplainedReferences, []);
});

test("a residual has no implicit aliases and cannot absorb a foreign, ambiguous, or overflowing reference", () => {
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN1399744", targets: [{ ...residual, receiptReferenceAliases: [] }] }).status, "unmatched");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN1399744", targets: [{ ...residual, receiptReferenceAliases: undefined }] }).status, "unmatched");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN9999999", targets: [child, residual] }).status, "unmatched");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN1399744", targets: [{ ...child, targetOrderRef: "SN1399744" }, residual] }).status, "ambiguous");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN1399744 SN1399025", targets: [child, residual] }).status, "ambiguous");
  const result = allocateScmReceiptRowsBySplitReference({ targets: [child, residual], totalReceivedQty: 41, receiptRows: [{ transactionMemo: "SN1399744", quantity: 41 }] });
  assert.deepEqual(result.allocations, [0, 40]);
  assert.equal(result.referenceOverflowQty, 1);
  assert.match(result.unexplainedReferences[0].reason, /capacity/);
});

test("explicit source aliases are literal and do not turn the parent reference into a receipt target", () => {
  const target = { ...residual, targetOrderRef: "POB03774", receiptReferenceAliases: ["LOAD.7(1)"] };
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "POB03774", targets: [target] }).status, "absent");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "XLOAD.7(1)Y", targets: [target] }).status, "absent");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "Receipt for LOAD.7(1)", targets: [target] }).status, "matched");
});

test("source-referenced receipts conserve quantities, fill only the named residual, and are deterministic", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 }), (capacity, received) => {
    const input = { targets: [child, { ...residual, requestedQty: capacity }], totalReceivedQty: received, receiptRows: [{ transactionMemo: "SN1399744", quantity: received }] };
    const actual = allocateScmReceiptRowsBySplitReference(input);
    assert.deepEqual(actual.allocations, [0, Math.min(capacity, received)]);
    assert.equal(actual.referenceOverflowQty, Math.max(received - capacity, 0));
    assert.equal(actual.allocations.reduce((sum, qty) => sum + qty, 0) + actual.referenceOverflowQty + actual.remainingTotalQty, received);
    assert.deepEqual(allocateScmReceiptRowsBySplitReference(input), actual);
  }), { seed: 1399025, numRuns: 250 });
});

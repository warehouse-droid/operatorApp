import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  allocateScmReceiptRowsBySplitReference,
  resolveScmReceiptSplitReference
} from "../../../src/scm-ir-split-reference.js";

test("case, spacing, and note variations always resolve to the same unique split child", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1_000_000, max: 9_999_999 }),
    fc.integer({ min: 1, max: 10_000 }),
    fc.boolean(),
    (digits, quantity, lowercase) => {
      const ref = `SN${digits}`;
      const memo = `${lowercase ? "sn" : "SN"} ${digits} (received load)`;
      const targets = [{ targetOrderRef: ref, targetKind: "po_split", requestedQty: quantity }];
      const resolved = resolveScmReceiptSplitReference({ transactionMemo: memo, targets });
      assert.equal(resolved.status, "matched");
      assert.equal(resolved.targetOrderRef, ref);

      const allocation = allocateScmReceiptRowsBySplitReference({
        totalReceivedQty: quantity,
        targets,
        receiptRows: [{ transactionMemo: memo, quantity }]
      });
      assert.deepEqual(allocation.allocations, [quantity]);
      assert.equal(allocation.referenceOverflowQty, 0);
    }
  ), { numRuns: 250 });
});

test("a distinct foreign split reference never allocates to the available target", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1_000_000, max: 8_999_999 }),
    fc.integer({ min: 1, max: 10_000 }),
    (digits, quantity) => {
      const targets = [{
        targetOrderRef: `SN${digits}`,
        targetKind: "po_split",
        requestedQty: quantity
      }];
      const result = allocateScmReceiptRowsBySplitReference({
        totalReceivedQty: quantity,
        targets,
        receiptRows: [{ transactionMemo: `SN${digits + 1_000_000}`, quantity }]
      });
      assert.deepEqual(result.allocations, [0]);
      assert.equal(result.referenceOverflowQty, quantity);
      assert.equal(result.unexplainedReferences.length, 1);
    }
  ), { numRuns: 250 });
});

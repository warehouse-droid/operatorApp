import assert from "node:assert/strict";
import test from "node:test";
import { allocateSplitReceiptsByDestination } from "../../../src/scm-split-receipt-allocation.js";

function allocationMap(result) {
  return Object.fromEntries(result.allocations.map((allocation) => [
    allocation.targetOrderRef,
    allocation.allocatedQty
  ]));
}

test("destination allocation conserves quantity and is target-order invariant", () => {
  for (let index = 1; index <= 500; index += 1) {
    const first = Number(((index % 17) + 0.25).toFixed(2));
    const second = Number(((index % 23) + 0.75).toFixed(2));
    const targets = [
      {
        targetOrderRef: `A-${index}`,
        requestedQty: first,
        destinationLocationId: 15,
        plannedEta: "2026-08-01"
      },
      {
        targetOrderRef: `B-${index}`,
        requestedQty: second,
        destinationLocationId: 1,
        plannedEta: "2026-08-02"
      }
    ];
    const input = {
      totalReceivedQty: first + second,
      receiptRows: [
        { quantity: first, actualLocationId: 15 },
        { quantity: second, actualLocationId: 1 }
      ]
    };
    const forward = allocateSplitReceiptsByDestination({ ...input, targets });
    const reverse = allocateSplitReceiptsByDestination({ ...input, targets: [...targets].reverse() });
    assert.deepEqual(allocationMap(forward), allocationMap(reverse));
    assert.equal(forward.conflict, false);
    assert.equal(
      Number(forward.allocations.reduce((sum, row) => sum + row.allocatedQty, 0).toFixed(6)),
      Number((first + second).toFixed(6))
    );
    assert.equal(forward.allocations[0].allocatedQty <= forward.allocations[0].requestedQty, true);
    assert.equal(forward.allocations[1].allocatedQty <= forward.allocations[1].requestedQty, true);
  }
});

test("no known-location quantity crosses destination under adversarial capacity", () => {
  for (let index = 1; index <= 250; index += 1) {
    const observed = index + 0.5;
    const capacity = Math.max(index - 3, 0);
    const result = allocateSplitReceiptsByDestination({
      totalReceivedQty: observed,
      receiptRows: [{ quantity: observed, actualLocationId: 15 }],
      targets: [
        { targetOrderRef: "MATCH", requestedQty: capacity, destinationLocationId: 15 },
        { targetOrderRef: "WRONG", requestedQty: 1_000_000, destinationLocationId: 1 }
      ]
    });
    assert.equal(allocationMap(result).WRONG, 0);
    assert.equal(result.conflict, observed > capacity);
    assert.equal(result.overflowQty, Number(Math.max(observed - capacity, 0).toFixed(6)));
  }
});

test("historical IR never allocates to an unfinished split and remains conserved", () => {
  for (let index = 1; index <= 250; index += 1) {
    const completedQty = Number((index + 0.25).toFixed(2));
    const residualQty = Number(((index % 7) + 0.5).toFixed(2));
    const total = Number((completedQty + residualQty).toFixed(2));
    const result = allocateSplitReceiptsByDestination({
      totalReceivedQty: total,
      receiptRows: [{
        transactionDate: "2026-08-05",
        quantity: total,
        actualLocationId: 15
      }],
      targets: [
        {
          targetOrderRef: "COMPLETED",
          requestedQty: completedQty,
          destinationLocationId: 28,
          createdAt: "2026-08-01",
          operationallyCompleted: true,
          allowInferredReceipt: true
        },
        {
          targetOrderRef: "FUTURE-UNFINISHED",
          requestedQty: 1_000_000,
          destinationLocationId: 15,
          createdAt: "2026-08-01",
          operationallyCompleted: false,
          allowInferredReceipt: false
        },
        {
          targetOrderRef: "PARENT",
          requestedQty: residualQty,
          destinationLocationId: 15,
          isParent: true,
          allowInferredReceipt: true
        }
      ]
    });
    const allocations = allocationMap(result);
    assert.equal(allocations.COMPLETED, completedQty);
    assert.equal(allocations["FUTURE-UNFINISHED"], 0);
    assert.equal(allocations.PARENT, residualQty);
    assert.equal(
      Number(result.allocations.reduce((sum, row) => sum + row.allocatedQty, 0).toFixed(6)),
      total
    );
    assert.equal(result.conflict, false);
  }
});

test("historical IR may satisfy a completed child regardless of record creation date", () => {
  for (let index = 1; index <= 250; index += 1) {
    const quantity = Number((index + 0.125).toFixed(3));
    const result = allocateSplitReceiptsByDestination({
      totalReceivedQty: quantity,
      receiptRows: [{
        transactionDate: "2026-08-05",
        quantity,
        actualLocationId: 15
      }],
      targets: [
        {
          targetOrderRef: "FUTURE-COMPLETED",
          requestedQty: quantity,
          destinationLocationId: 15,
          createdAt: "2026-08-20",
          operationallyCompleted: true,
          allowInferredReceipt: true
        },
        {
          targetOrderRef: "PARENT",
          requestedQty: quantity,
          destinationLocationId: 15,
          isParent: true,
          allowInferredReceipt: true
        }
      ]
    });
    assert.deepEqual(allocationMap(result), {
      "FUTURE-COMPLETED": quantity,
      PARENT: 0
    });
    assert.equal(result.conflict, false);
  }
});

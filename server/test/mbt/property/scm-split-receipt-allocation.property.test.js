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

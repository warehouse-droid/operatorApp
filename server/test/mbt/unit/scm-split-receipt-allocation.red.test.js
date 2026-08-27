import assert from "node:assert/strict";
import test from "node:test";
import { allocateSplitReceiptsByDestination } from "../../../src/scm-split-receipt-allocation.js";

function byRef(result) {
  return Object.fromEntries(result.allocations.map((allocation) => [
    allocation.targetOrderRef,
    allocation.allocatedQty
  ]));
}

test("allocates known receipt locations only to matching split destinations", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 10,
    receiptRows: [
      { quantity: 4, actualLocationId: 15 },
      { quantity: 6, actualLocationId: 1 }
    ],
    targets: [
      { targetOrderRef: "3022019914", requestedQty: 4, destinationLocationId: 15 },
      { targetOrderRef: "SPLIT-3445", requestedQty: 6, destinationLocationId: 1 }
    ]
  });

  assert.deepEqual(byRef(result), {
    "3022019914": 4,
    "SPLIT-3445": 6
  });
  assert.equal(result.conflict, false);
  assert.equal(result.overflowQty, 0);
  assert.deepEqual(result.unexplainedLocations, []);
  assert.equal(result.locationAware, true);
});

test("uses existing priority within one destination and does not cross yards", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 7,
    receiptRows: [{ quantity: 7, actualLocationId: 15 }],
    targets: [
      {
        targetOrderRef: "LATER",
        requestedQty: 5,
        destinationLocationId: 15,
        plannedEta: "2026-08-20"
      },
      {
        targetOrderRef: "EARLIER",
        requestedQty: 4,
        destinationLocationId: 15,
        plannedEta: "2026-08-10"
      },
      {
        targetOrderRef: "OTHER-YARD",
        requestedQty: 99,
        destinationLocationId: 1,
        plannedEta: "2026-08-01"
      }
    ]
  });
  assert.deepEqual(byRef(result), {
    LATER: 3,
    EARLIER: 4,
    "OTHER-YARD": 0
  });
  assert.equal(result.conflict, false);
});

test("preserves exact evidence before inferred priority within a destination", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 7,
    receiptRows: [{ quantity: 7, actualLocationId: 15 }],
    targets: [
      {
        targetOrderRef: "EXACT",
        requestedQty: 5,
        exactReceivedQty: 5,
        destinationLocationId: 15,
        plannedEta: "2026-08-30"
      },
      {
        targetOrderRef: "EARLY",
        requestedQty: 5,
        destinationLocationId: 15,
        plannedEta: "2026-08-01"
      }
    ]
  });
  assert.deepEqual(byRef(result), { EXACT: 5, EARLY: 2 });
  assert.equal(result.allocations[0].allocationMethod, "exact");
});

test("unknown-location receipt quantity falls back to remaining capacity", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 10,
    receiptRows: [
      { quantity: 4, actualLocationId: 15 },
      { quantity: 6, actualLocationId: null }
    ],
    targets: [
      { targetOrderRef: "YARD-15", requestedQty: 4, destinationLocationId: 15 },
      { targetOrderRef: "YARD-1", requestedQty: 6, destinationLocationId: 1 }
    ]
  });
  assert.deepEqual(byRef(result), { "YARD-15": 4, "YARD-1": 6 });
  assert.equal(result.conflict, false);
});

test("merges repeated and mixed evidence conservatively on the same target", () => {
  const repeated = allocateSplitReceiptsByDestination({
    totalReceivedQty: 10,
    receiptRows: [
      { quantity: 4, actualLocationId: 15 },
      { quantity: 6, actualLocationId: null }
    ],
    targets: [{
      targetOrderRef: "REPEATED",
      requestedQty: 10,
      destinationLocationId: 15
    }]
  });
  assert.equal(repeated.allocations[0].allocationMethod, "inferred");

  const mixed = allocateSplitReceiptsByDestination({
    totalReceivedQty: 10,
    receiptRows: [
      { quantity: 4, actualLocationId: 15 },
      { quantity: 6, actualLocationId: null }
    ],
    targets: [{
      targetOrderRef: "MIXED",
      requestedQty: 10,
      exactReceivedQty: 4,
      destinationLocationId: 15
    }]
  });
  assert.equal(mixed.allocations[0].allocatedQty, 10);
  assert.equal(mixed.allocations[0].allocationMethod, "inferred");
  assert.equal(mixed.conflict, false);
});

test("ignores non-positive rows and accepts defensive non-array inputs", () => {
  const empty = allocateSplitReceiptsByDestination({
    totalReceivedQty: 0,
    targets: null,
    receiptRows: null
  });
  assert.deepEqual(empty.allocations, []);
  assert.equal(empty.conflict, false);

  const nonPositive = allocateSplitReceiptsByDestination({
    totalReceivedQty: 0,
    receiptRows: [null, { quantity: 0 }, { quantity: -5, actualLocationId: 15 }],
    targets: [{ targetOrderRef: "ZERO", requestedQty: 5, destinationLocationId: 15 }]
  });
  assert.equal(nonPositive.allocations[0].allocatedQty, 0);
  assert.equal(nonPositive.locationAware, false);
});

test("skips zero allocations while merging a partially filled destination bucket", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 1,
    receiptRows: [{ quantity: 1, actualLocationId: 15 }],
    targets: [
      { targetOrderRef: "FIRST", requestedQty: 1, destinationLocationId: 15, plannedEta: "2026-08-01" },
      { targetOrderRef: "SECOND", requestedQty: 1, destinationLocationId: 15, plannedEta: "2026-08-02" }
    ]
  });
  assert.deepEqual(byRef(result), { FIRST: 1, SECOND: 0 });
});

test("known receipt location never spills into another destination", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 6,
    receiptRows: [{ quantity: 6, actualLocationId: 15 }],
    targets: [
      { targetOrderRef: "YARD-15", requestedQty: 4, destinationLocationId: 15 },
      { targetOrderRef: "YARD-1", requestedQty: 100, destinationLocationId: 1 }
    ]
  });
  assert.deepEqual(byRef(result), { "YARD-15": 4, "YARD-1": 0 });
  assert.equal(result.conflict, true);
  assert.equal(result.overflowQty, 2);
  assert.deepEqual(result.unexplainedLocations, [{ locationId: 15, quantity: 2 }]);
});

test("location routing cannot silently discard exact child evidence", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [{ quantity: 5, actualLocationId: 1 }],
    targets: [
      {
        targetOrderRef: "EXACT-YARD-15",
        requestedQty: 5,
        exactReceivedQty: 5,
        destinationLocationId: 15
      },
      {
        targetOrderRef: "YARD-1",
        requestedQty: 5,
        destinationLocationId: 1
      }
    ]
  });
  assert.equal(result.conflict, true);
  assert.equal(result.unallocatedExactQty, 5);
});

test("row totals inconsistent with reconciled total fail closed", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [{ quantity: 7, actualLocationId: 15 }],
    targets: [{ targetOrderRef: "YARD-15", requestedQty: 10, destinationLocationId: 15 }]
  });
  assert.equal(result.conflict, true);
  assert.equal(result.allocations[0].allocatedQty, 5);
  assert.equal(result.overflowQty, 2);
});

test("empty receipt rows preserve the legacy aggregate allocator", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [],
    targets: [
      { targetOrderRef: "FIRST", requestedQty: 3, plannedEta: "2026-08-01" },
      { targetOrderRef: "SECOND", requestedQty: 4, plannedEta: "2026-08-02" }
    ]
  });
  assert.deepEqual(byRef(result), { FIRST: 3, SECOND: 2 });
  assert.equal(result.locationAware, false);
  assert.equal(result.conflict, false);
});

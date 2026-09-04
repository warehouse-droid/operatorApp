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

test("later exact child evidence can consume the unlocated balance without reopening review", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 2937.48,
    receiptRows: [
      { quantity: 629.46, actualLocationId: 15 },
      { quantity: 629.46, actualLocationId: 1 }
    ],
    targets: [
      {
        targetOrderRef: "SN1397704",
        requestedQty: 629.46,
        destinationLocationId: 15,
        createdAt: "2026-08-10T00:00:00.000Z"
      },
      {
        targetOrderRef: "SN1397965",
        requestedQty: 629.46,
        destinationLocationId: 1,
        createdAt: "2026-08-11T00:00:00.000Z"
      },
      {
        targetOrderRef: "SN1399496",
        requestedQty: 1678.56,
        exactReceivedQty: 1678.56,
        destinationLocationId: 1,
        actualDispatchAt: "2026-09-01T14:34:34.625Z",
        createdAt: "2026-08-31T00:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(byRef(result), {
    SN1397704: 629.46,
    SN1397965: 629.46,
    SN1399496: 1678.56
  });
  assert.equal(result.overflowQty, 0);
  assert.equal(result.unallocatedExactQty, 0);
  assert.equal(result.conflict, false,
    "the exact completion is covered by the parent total after its unlocated balance is applied");
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

test("POB03535 completed children consume historical IR globally before unfinished 3022143273", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 13_807.2,
    receiptRows: [
      { transactionRef: "IR13777", transactionDate: "2026-08-05", quantity: 2301.2, actualLocationId: 15 },
      { transactionRef: "IR14031", transactionDate: "2026-08-17", quantity: 1359.8, actualLocationId: 15 },
      { transactionRef: "IR14124", transactionDate: "2026-08-21", quantity: 2301.2, actualLocationId: 15 },
      { transactionRef: "IR14218", transactionDate: "2026-08-24", quantity: 2301.2, actualLocationId: 15 },
      { transactionRef: "IR13395", transactionDate: "2026-07-14", quantity: 2301.2, actualLocationId: 28 },
      { transactionRef: "IR13622", transactionDate: "2026-07-28", quantity: 2301.2, actualLocationId: 28 },
      { transactionRef: "IR14088", transactionDate: "2026-08-20", quantity: 941.4, actualLocationId: 28 }
    ],
    targets: [
      { targetOrderRef: "3022021494", requestedQty: 2301.2, destinationLocationId: 28, createdAt: "2026-07-09", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022069120", requestedQty: 2301.2, destinationLocationId: 28, createdAt: "2026-07-27", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022069127", requestedQty: 2301.2, destinationLocationId: 28, createdAt: "2026-07-27", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022124135", requestedQty: 1359.8, destinationLocationId: 15, createdAt: "2026-08-13", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022134768", requestedQty: 2301.2, destinationLocationId: 15, createdAt: "2026-08-18", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022134771", requestedQty: 2301.2, destinationLocationId: 15, createdAt: "2026-08-18", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022138841", requestedQty: 941.4, destinationLocationId: 28, createdAt: "2026-08-19", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022143273", requestedQty: 2301.2, destinationLocationId: 15, createdAt: "2026-08-20", operationallyCompleted: false, allowInferredReceipt: false }
    ]
  });

  const allocations = byRef(result);
  assert.equal(allocations["3022143273"], 0);
  assert.equal(allocations["3022069120"], 2301.2);
  assert.equal(allocations["3022138841"], 941.4);
  assert.equal(
    Number(result.allocations.reduce(
      (sum, allocation) => sum + allocation.allocatedQty,
      0
    ).toFixed(6)),
    13_807.2
  );
  assert.equal(result.conflict, false);
  assert.equal(result.overflowQty, 0);
  assert.deepEqual(result.unexplainedLocations, []);
});

test("POB03535 pallet IR leaves source residual and never fills unfinished 3022143273", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 873,
    receiptRows: [
      { transactionRef: "IR-3445", transactionDate: "2026-07-20", quantity: 17, actualLocationId: 1 },
      { transactionRef: "IR-12441-OLD", transactionDate: "2026-08-01", quantity: 205, actualLocationId: 15 },
      { transactionRef: "IR13777", transactionDate: "2026-08-05", quantity: 22, actualLocationId: 15 },
      { transactionRef: "IR-12441-LATER", transactionDate: "2026-08-24", quantity: 146, actualLocationId: 15 },
      { transactionRef: "IR-2967", transactionDate: "2026-08-24", quantity: 483, actualLocationId: 28 }
    ],
    targets: [
      { targetOrderRef: "COMPLETED-3445", requestedQty: 17, destinationLocationId: 1, createdAt: "2026-07-01", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "COMPLETED-12441-OLD", requestedQty: 205, destinationLocationId: 15, createdAt: "2026-07-01", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "COMPLETED-12441-LATER", requestedQty: 146, destinationLocationId: 15, createdAt: "2026-08-06", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "COMPLETED-2967", requestedQty: 473, destinationLocationId: 28, createdAt: "2026-07-01", operationallyCompleted: true, allowInferredReceipt: true },
      { targetOrderRef: "3022143273", requestedQty: 22, destinationLocationId: 15, createdAt: "2026-08-20", operationallyCompleted: false, allowInferredReceipt: false },
      { targetOrderRef: "POB03535", requestedQty: 1000, destinationLocationId: 28, isParent: true, allowInferredReceipt: true }
    ]
  });

  assert.deepEqual(byRef(result), {
    "COMPLETED-3445": 17,
    "COMPLETED-12441-OLD": 205,
    "COMPLETED-12441-LATER": 146,
    "COMPLETED-2967": 473,
    "3022143273": 0,
    POB03535: 32
  });
  assert.equal(result.conflict, false);
  assert.equal(result.overflowQty, 0);
});

test("exact child evidence still allocates to an unfinished split", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [{ transactionDate: "2026-08-01", quantity: 5, actualLocationId: 15 }],
    targets: [{
      targetOrderRef: "EXACT-UNFINISHED",
      requestedQty: 5,
      exactReceivedQty: 5,
      destinationLocationId: 15,
      createdAt: "2026-08-20",
      operationallyCompleted: false,
      allowInferredReceipt: false
    }]
  });

  assert.deepEqual(byRef(result), { "EXACT-UNFINISHED": 5 });
  assert.equal(result.allocations[0].allocationMethod, "exact");
  assert.equal(result.conflict, false);
});

test("inferred receipt can fill an eligible non-completed target only after it exists", () => {
  const beforeCreation = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [{ transactionDate: "2026-08-01", quantity: 5, actualLocationId: 15 }],
    targets: [{
      targetOrderRef: "CREATED-LATER",
      requestedQty: 5,
      destinationLocationId: 15,
      createdAt: "2026-08-02",
      operationallyCompleted: false,
      allowInferredReceipt: true
    }]
  });
  assert.deepEqual(byRef(beforeCreation), { "CREATED-LATER": 0 });
  assert.equal(beforeCreation.conflict, true,
    "a known-yard receipt from before target creation must remain unexplained");

  const afterCreation = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [{ transactionDate: "2026-08-02", quantity: 5, actualLocationId: 15 }],
    targets: [{
      targetOrderRef: "CREATED-EARLIER",
      requestedQty: 5,
      destinationLocationId: 15,
      createdAt: "2026-08-01",
      operationallyCompleted: false,
      allowInferredReceipt: true
    }]
  });
  assert.deepEqual(byRef(afterCreation), { "CREATED-EARLIER": 5 });
  assert.equal(afterCreation.conflict, false);
});

test("protected allocation reports repeated unexplained rows deterministically", () => {
  const result = allocateSplitReceiptsByDestination({
    totalReceivedQty: 5,
    receiptRows: [
      { transactionRef: "IR-B", transactionDate: "not-a-date", quantity: 3, actualLocationId: 15 },
      { transactionRef: "IR-A", transactionDate: "not-a-date", quantity: 4, actualLocationId: 15 }
    ],
    targets: [{
      targetOrderRef: "UNFINISHED",
      requestedQty: 10,
      destinationLocationId: 15,
      createdAt: "2026-08-01",
      operationallyCompleted: false,
      allowInferredReceipt: false
    }]
  });

  assert.deepEqual(byRef(result), { UNFINISHED: 0 });
  assert.equal(result.conflict, true);
  assert.equal(result.overflowQty, 7);
  assert.deepEqual(result.unexplainedLocations, [{ locationId: 15, quantity: 7 }]);
});

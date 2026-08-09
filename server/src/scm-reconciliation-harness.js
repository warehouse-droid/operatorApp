import assert from "node:assert/strict";
import {
  allocateReconciliationProgress,
  classifyNetSuiteLifecycle,
  derivePoToReconciliationState,
  rollupReconciliationGroup
} from "./scm-reconciliation.js";

assert.equal(classifyNetSuiteLifecycle("Partially Received").closed, false);
assert.equal(classifyNetSuiteLifecycle("Partially Received").partiallyReceived, true);
assert.equal(classifyNetSuiteLifecycle("Closed").closed, true);

assert.equal(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Partially Received",
  orderedQty: 100,
  receivedQty: 40
}).applicationStatus, "Partially Done");

assert.deepEqual(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Closed",
  orderedQty: 100,
  receivedQty: 40
}).quantities, {
  ordered: 100,
  fulfilled: 0,
  received: 40,
  abandoned: 60,
  remaining: 0,
  destinationRemaining: 0
});

assert.equal(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Closed",
  orderedQty: 100,
  receivedQty: 40
}).applicationStatus, "Completed");

assert.equal(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Closed",
  orderedQty: 100,
  receivedQty: 0
}).applicationStatus, "Cancelled");

assert.equal(derivePoToReconciliationState({
  kind: "TO",
  statusText: "Pending Receipt",
  orderedQty: 100,
  fulfilledQty: 100,
  receivedQty: 0
}).applicationStatus, "In Transit");

assert.equal(derivePoToReconciliationState({
  kind: "TO",
  statusText: "Closed",
  orderedQty: 100,
  fulfilledQty: 100,
  receivedQty: 0
}).reconciliationStatus, "review");

assert.equal(derivePoToReconciliationState({
  kind: "TO",
  statusText: "Received",
  orderedQty: 100,
  fulfilledQty: 100,
  receivedQty: 100
}).applicationStatus, "Completed");

assert.equal(derivePoToReconciliationState({
  kind: "TO",
  statusText: "Cancelled",
  orderedQty: 100,
  fulfilledQty: 20,
  receivedQty: 0
}).reconciliationStatus, "review");

for (const statusText of ["Cancelled", "Hold"]) {
  const fullDestinationReceipt = derivePoToReconciliationState({
    kind: "TO",
    statusText,
    orderedQty: 100,
    fulfilledQty: 0,
    receivedQty: 100
  });
  assert.equal(fullDestinationReceipt.applicationStatus, "Completed");
  assert.equal(fullDestinationReceipt.reconciliationStatus, "ok");
  assert.equal(fullDestinationReceipt.quantities.remaining, 0);
}

assert.equal(derivePoToReconciliationState({
  kind: "TO",
  statusText: "Cancelled",
  orderedQty: 100,
  fulfilledQty: 0,
  receivedQty: 101
}).reconciliationStatus, "review");

assert.equal(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Pending Receipt",
  orderedQty: 100,
  receivedQty: 0,
  previousStatus: "Completed",
  previousReceivedQty: 100
}).reconciliationStatus, "review");

assert.equal(derivePoToReconciliationState({
  kind: "PO",
  statusText: "Closed",
  orderedQty: 100,
  receivedQty: 40,
  previousStatus: "Completed",
  previousReceivedQty: 100
}).reconciliationStatus, "review");

const allocation = allocateReconciliationProgress(70, [
  { ref: "PO-S1", requestedQty: 40, exactQty: 10, createdAt: "2026-07-01" },
  { ref: "PO-S2", requestedQty: 40, plannedEta: "2026-07-03", createdAt: "2026-07-02" },
  { ref: "PO", requestedQty: 20, isParent: true, createdAt: "2026-06-01" }
], { parentRef: "PO" });
assert.deepEqual(allocation.allocations.map((item) => item.allocatedQty), [30, 40, 0]);
assert.deepEqual(allocation.allocations.map((item) => item.allocationMethod), ["exact", "inferred", ""]);
assert.equal(allocation.overflowQty, 0);

const correctionConflict = allocateReconciliationProgress(5, [
  { ref: "TO-S1", requestedQty: 10, exactQty: 8, pinned: true },
  { ref: "TO-S2", requestedQty: 10, exactQty: 4, pinned: true }
]);
assert.equal(correctionConflict.conflict, true);

assert.deepEqual(rollupReconciliationGroup([
  { status: "Completed", reconciliationStatus: "ok" },
  { status: "Queued", reconciliationStatus: "ok" }
]), { applicationStatus: "Partially Done", reconciliationStatus: "ok" });

assert.deepEqual(rollupReconciliationGroup([
  { status: "Completed", reconciliationStatus: "ok" },
  { status: "Cancelled", reconciliationStatus: "ok" }
]), { applicationStatus: "Completed", reconciliationStatus: "ok" });

for (let memberCount = 2; memberCount <= 20; memberCount += 1) {
  for (let completedCount = 0; completedCount <= memberCount; completedCount += 1) {
    const members = Array.from({ length: memberCount }, (_, index) => ({
      status: index < completedCount ? "Completed" : "Queued",
      reconciliationStatus: "ok"
    }));
    const expected = completedCount === memberCount
      ? "Completed"
      : completedCount > 0
        ? "Partially Done"
        : "Queued";
    assert.equal(rollupReconciliationGroup(members).applicationStatus, expected,
      "Grouped PO rollup must account for every active child at every supported group size.");
  }
}

assert.deepEqual(rollupReconciliationGroup([
  { status: "Completed", reconciliationStatus: "ok" },
  { status: "Completed", reconciliationStatus: "review" }
]), { applicationStatus: "Reconcile Review", reconciliationStatus: "review" });

console.log("SCM PO/TO reconciliation harness passed.");

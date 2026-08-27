import assert from "node:assert/strict";
import test from "node:test";

import { applySplitTargetEvidencePrecedence } from "../../../src/scm-reconciliation.js";
import { scmScheduleEffectiveReconciliationStatus } from "../../../src/scm-reconciliation-repository.js";

function state(applicationStatus, {
  reconciliationStatus = "ok",
  reason = "",
  lifecycle = {}
} = {}) {
  return {
    applicationStatus,
    reconciliationStatus,
    reason,
    lifecycle,
    quantities: {
      ordered: 10,
      fulfilled: 0,
      received: applicationStatus === "Completed" ? 10 : 4,
      abandoned: 0,
      remaining: applicationStatus === "Completed" ? 0 : 6,
      destinationRemaining: applicationStatus === "Completed" ? 0 : 6
    }
  };
}

test("SPSE-U1: SN1397956 inferred-only partial progress remains Planned", () => {
  const derived = state("Partially Done");
  const actual = applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Partially Done",
    hasActivePlan: true,
    evidencedReceivedQty: 0,
    evidencedFulfilledQty: 0,
    derivedState: derived
  });

  assert.equal(actual.applicationStatus, "Planned");
  assert.equal(actual.reconciliationStatus, "ok");
  assert.equal(actual.reason, "");
  assert.deepEqual(actual.quantities, derived.quantities,
    "inferred quantities remain visible even though they cannot drive status");
});

test("SPSE-U2: 3022069120 cannot regress from Completed when inferred allocation moves", () => {
  const actual = applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Completed",
    hasActivePlan: false,
    evidencedReceivedQty: 0,
    evidencedFulfilledQty: 0,
    derivedState: state("Reconcile Review", {
      reconciliationStatus: "review",
      reason: "A previously completed order lost destination receipt evidence."
    })
  });

  assert.equal(actual.applicationStatus, "Completed");
  assert.equal(actual.reconciliationStatus, "ok");
  assert.equal(actual.reason, "");
});

test("SPSE-U3: exact or pinned progress above reconciliation tolerance may produce Partially Done", () => {
  for (const evidencedReceivedQty of [0.000002, 4]) {
    const derived = state("Partially Done");
    const actual = applySplitTargetEvidencePrecedence({
      targetKind: "po_split",
      previousStatus: "Planned",
      hasActivePlan: true,
      evidencedReceivedQty,
      derivedState: derived
    });
    assert.equal(actual.applicationStatus, "Partially Done");
  }
});

test("SPSE-U4: fully allocated inferred child retains Completed", () => {
  const derived = state("Completed");
  const actual = applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Planned",
    hasActivePlan: true,
    evidencedReceivedQty: 0,
    derivedState: derived
  });
  assert.deepEqual(actual, derived);
});

test("SPSE-U5: source residual and genuine lifecycle review behavior are unchanged", () => {
  const partial = state("Partially Done");
  assert.deepEqual(applySplitTargetEvidencePrecedence({
    targetKind: "source_residual",
    previousStatus: "Planned",
    hasActivePlan: true,
    derivedState: partial
  }), partial);

  const cancelledReview = state("Reconcile Review", {
    reconciliationStatus: "review",
    reason: "NetSuite cancelled or voided an order that has partial operational progress.",
    lifecycle: { cancelled: true }
  });
  assert.deepEqual(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Completed",
    evidencedReceivedQty: 0,
    derivedState: cancelledReview
  }), cancelledReview);
});

test("SPSE-U6: no-plan inferred partial falls back to a non-progress state", () => {
  const inferredPartial = state("Partially Done");
  assert.equal(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Reconcile Review",
    hasActivePlan: false,
    derivedState: inferredPartial
  }).applicationStatus, "Queued");

  assert.equal(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Hold",
    hasActivePlan: false,
    derivedState: inferredPartial
  }).applicationStatus, "Hold");
});

test("SPSE-U7: a saved local Completed status wins while nonterminal review remains visible", () => {
  assert.equal(scmScheduleEffectiveReconciliationStatus({
    scheduleStatus: "Completed",
    reconciliationStatus: "review",
    reconciliationApplicationStatus: "Partially Done",
    blockingReview: true
  }), "Completed");

  assert.equal(scmScheduleEffectiveReconciliationStatus({
    scheduleStatus: "Planned",
    reconciliationStatus: "review",
    reconciliationApplicationStatus: "Partially Done",
    blockingReview: true
  }), "Reconcile Review");
});

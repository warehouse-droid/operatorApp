import assert from "node:assert/strict";
import test from "node:test";

import { applySplitTargetEvidencePrecedence } from "../../../src/scm-split-status-evidence-precedence.js";

function derived(applicationStatus, reason = "", lifecycle = {}) {
  return {
    applicationStatus,
    reconciliationStatus: applicationStatus === "Reconcile Review" ? "review" : "ok",
    reason,
    lifecycle,
    quantities: { ordered: 10, fulfilled: 0, received: 4, remaining: 6 }
  };
}

test("SPSE-A1: a genuine review is never hidden merely because the previous status was Completed", () => {
  const review = derived(
    "Reconcile Review",
    "NetSuite progress exceeds the current ordered quantity or destination receipt exceeds fulfillment."
  );
  assert.strictEqual(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Completed",
    derivedState: review
  }), review);
});

test("SPSE-A2: malformed, negative, and tolerance-only evidence cannot manufacture progress", () => {
  for (const evidence of [null, undefined, "", "not-a-number", -99, 0.000001]) {
    assert.equal(applySplitTargetEvidencePrecedence({
      targetKind: "to_split",
      previousStatus: "In Transit",
      hasActivePlan: true,
      evidencedFulfilledQty: evidence,
      evidencedReceivedQty: evidence,
      derivedState: derived("In Transit")
    }).applicationStatus, "Planned");
  }

  assert.equal(applySplitTargetEvidencePrecedence({
    targetKind: "to_split",
    previousStatus: "Planned",
    evidencedFulfilledQty: "1,000",
    derivedState: derived("In Transit")
  }).applicationStatus, "In Transit");
});

test("SPSE-A3: split identity is normalized but unrelated targets remain byte-for-byte unchanged", () => {
  const partial = derived("Partially Done");
  assert.equal(applySplitTargetEvidencePrecedence({
    targetKind: "  PO_SPLIT  ",
    previousStatus: "Queued",
    derivedState: partial
  }).applicationStatus, "Queued");

  assert.strictEqual(applySplitTargetEvidencePrecedence({
    targetKind: "group_member",
    previousStatus: "Queued",
    derivedState: partial
  }), partial);
  assert.deepEqual(applySplitTargetEvidencePrecedence(), {});
  assert.deepEqual(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: null,
    derivedState: {}
  }), {});
});

test("SPSE-A4: terminal lifecycle and terminal application decisions remain authoritative", () => {
  for (const lifecycle of [{ closed: true }, { cancelled: true }]) {
    const review = derived("Reconcile Review", "lifecycle conflict", lifecycle);
    assert.strictEqual(applySplitTargetEvidencePrecedence({
      targetKind: "po_split",
      previousStatus: "Completed",
      derivedState: review
    }), review);

    const lifecyclePartial = derived("Partially Done", "", lifecycle);
    assert.strictEqual(applySplitTargetEvidencePrecedence({
      targetKind: "po_split",
      previousStatus: "Queued",
      hasActivePlan: true,
      derivedState: lifecyclePartial
    }), lifecyclePartial);
  }

  for (const applicationStatus of ["Completed", "Cancelled"]) {
    const terminal = derived(applicationStatus);
    assert.strictEqual(applySplitTargetEvidencePrecedence({
      targetKind: "po_split",
      previousStatus: "Queued",
      derivedState: terminal
    }), terminal);
  }
});

test("SPSE-A5: legacy completion spelling is monotonic and a reasonless review remains visible", () => {
  assert.equal(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: " complete ",
    derivedState: derived("Queued")
  }).applicationStatus, "Completed");

  const review = {
    applicationStatus: "Reconcile Review",
    reconciliationStatus: "review"
  };
  assert.strictEqual(applySplitTargetEvidencePrecedence({
    targetKind: "po_split",
    previousStatus: "Completed",
    derivedState: review
  }), review);
});

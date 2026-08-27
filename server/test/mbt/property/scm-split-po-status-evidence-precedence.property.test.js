import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { applySplitTargetEvidencePrecedence } from "../../../src/scm-reconciliation.js";

const schedulingStatuses = [
  "Queued",
  "Planned",
  "Urgent",
  "Hold",
  "Priority",
  "Surplus Only",
  "Book Appt"
];

function partialState(received) {
  return {
    applicationStatus: "Partially Done",
    reconciliationStatus: "ok",
    reason: "",
    lifecycle: {},
    quantities: {
      ordered: 100,
      fulfilled: 0,
      received,
      abandoned: 0,
      remaining: 100 - received,
      destinationRemaining: 100 - received
    }
  };
}

test("SPSE-P1: inferred partial quantities never create operational progress", () => {
  fc.assert(fc.property(
    fc.double({ min: 0.000001, max: 99.999999, noNaN: true }),
    fc.boolean(),
    fc.constantFrom(...schedulingStatuses, "Partially Done", "Reconcile Review", "In Transit"),
    (received, hasActivePlan, previousStatus) => {
      const result = applySplitTargetEvidencePrecedence({
        targetKind: "po_split",
        previousStatus,
        hasActivePlan,
        evidencedReceivedQty: 0,
        evidencedFulfilledQty: 0,
        derivedState: partialState(received)
      });
      assert.ok(schedulingStatuses.includes(result.applicationStatus));
      if (hasActivePlan && !schedulingStatuses.includes(previousStatus)) {
        assert.equal(result.applicationStatus, "Planned");
      }
    }
  ), { numRuns: 500 });
});
test("SPSE-P2: Completed is monotonic across arbitrary inferred redistributions", () => {
  fc.assert(fc.property(
    fc.array(fc.double({ min: 0, max: 99.999999, noNaN: true }), {
      minLength: 1,
      maxLength: 50
    }),
    (redistributions) => {
      let previousStatus = "Completed";
      for (const received of redistributions) {
        const result = applySplitTargetEvidencePrecedence({
          targetKind: "po_split",
          previousStatus,
          hasActivePlan: false,
          evidencedReceivedQty: 0,
          derivedState: received > 0
            ? partialState(received)
            : {
                ...partialState(0),
                applicationStatus: "Queued"
              }
        });
        assert.equal(result.applicationStatus, "Completed");
        previousStatus = result.applicationStatus;
      }
    }
  ), { numRuns: 300 });
});

test("SPSE-P3: evidence precedence is deterministic and idempotent", () => {
  fc.assert(fc.property(
    fc.constantFrom("po_split", "to_split"),
    fc.constantFrom(...schedulingStatuses, "Partially Done", "Reconcile Review"),
    fc.boolean(),
    fc.double({ min: 0, max: 10, noNaN: true }),
    (targetKind, previousStatus, hasActivePlan, evidencedQty) => {
      const input = {
        targetKind,
        previousStatus,
        hasActivePlan,
        evidencedReceivedQty: evidencedQty,
        derivedState: partialState(4)
      };
      const first = applySplitTargetEvidencePrecedence(input);
      const repeated = applySplitTargetEvidencePrecedence(input);
      const replayed = applySplitTargetEvidencePrecedence({
        ...input,
        previousStatus: first.applicationStatus
      });
      assert.deepEqual(first, repeated);
      assert.equal(replayed.applicationStatus, first.applicationStatus);
    }
  ), { numRuns: 500 });
});

import test from "node:test";
import assert from "node:assert/strict";
import { deriveScmGroupSchedulePersistence } from "../../../src/scm-reconciliation-group-schedule.js";

const operationalStatuses = [
  "Queued",
  "Planned",
  "Partially Done",
  "In Transit",
  "Completed",
  "Urgent",
  "Hold"
];
const calculatedStatuses = ["Queued", "Partially Done", "In Transit", "Completed"];
const reconciliationStatuses = ["ok", "current", "pending", "review", "missing", "error"];

test("group persistence is idempotent and changes only a cleared legacy review status", () => {
  let examples = 0;
  for (const currentStatus of [...operationalStatuses, "Reconcile Review"]) {
    for (const applicationStatus of calculatedStatuses) {
      for (const reconciliationStatus of reconciliationStatuses) {
        examples += 1;
        const first = deriveScmGroupSchedulePersistence({
          currentStatus,
          applicationStatus,
          reconciliationStatus
        });
        const second = deriveScmGroupSchedulePersistence({
          currentStatus: first.persistedStatus,
          applicationStatus,
          reconciliationStatus
        });
        const expectedBlocked = ["review", "missing", "error"].includes(reconciliationStatus);
        assert.equal(first.reconciliationBlocked, expectedBlocked);
        assert.equal(second.persistedStatus, first.persistedStatus);
        if (currentStatus !== "Reconcile Review" || expectedBlocked) {
          assert.equal(first.persistedStatus, currentStatus);
        } else {
          assert.equal(first.persistedStatus, applicationStatus);
        }
      }
    }
  }
  assert.equal(examples, 192);
});

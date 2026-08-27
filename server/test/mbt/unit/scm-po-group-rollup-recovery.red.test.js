import test from "node:test";
import assert from "node:assert/strict";
import { deriveScmGroupSchedulePersistence } from "../../../src/scm-reconciliation-group-schedule.js";

test("cleared legacy Reconcile Review persists the calculated group status", () => {
  assert.deepEqual(deriveScmGroupSchedulePersistence({
    currentStatus: "Reconcile Review",
    applicationStatus: "Completed",
    reconciliationStatus: "ok"
  }), {
    applicationStatus: "Completed",
    reconciliationStatus: "ok",
    reconciliationBlocked: false,
    persistedStatus: "Completed"
  });
});

test("an active member review keeps the legacy group blocked", () => {
  assert.deepEqual(deriveScmGroupSchedulePersistence({
    currentStatus: "Reconcile Review",
    applicationStatus: "Reconcile Review",
    reconciliationStatus: "review"
  }), {
    applicationStatus: "Reconcile Review",
    reconciliationStatus: "review",
    reconciliationBlocked: true,
    persistedStatus: "Reconcile Review"
  });
});

test("calculated completion never overwrites a real operational group status", () => {
  assert.deepEqual(deriveScmGroupSchedulePersistence({
    currentStatus: "In Transit",
    applicationStatus: "Completed",
    reconciliationStatus: "ok"
  }), {
    applicationStatus: "Completed",
    reconciliationStatus: "ok",
    reconciliationBlocked: false,
    persistedStatus: "In Transit"
  });
});

test("blank inputs fail closed to canonical queued/pending values", () => {
  assert.deepEqual(deriveScmGroupSchedulePersistence(), {
    applicationStatus: "Queued",
    reconciliationStatus: "pending",
    reconciliationBlocked: false,
    persistedStatus: "Queued"
  });
  assert.deepEqual(deriveScmGroupSchedulePersistence({
    currentStatus: null,
    applicationStatus: null,
    reconciliationStatus: null
  }), {
    applicationStatus: "Queued",
    reconciliationStatus: "pending",
    reconciliationBlocked: false,
    persistedStatus: "Queued"
  });
});

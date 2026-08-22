import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAYED_STATUS_REFRESH_MAX_ATTEMPTS,
  delayedStatusRefreshDecision,
  delayedStatusRefreshRetryDelayMs,
  isDelayedStatusPendingApproval,
  normalizeDelayedStatusRefreshIdentity
} from "../../../src/netsuite-delayed-status-refresh-policy.js";

test("DSR-P1: identity validation accepts only supported order families and positive integer IDs", () => {
  assert.deepEqual(
    normalizeDelayedStatusRefreshIdentity({
      orderType: " purchase_order ",
      netsuiteOrderId: "959552",
      tranid: " POB03745 "
    }),
    { orderType: "purchase_order", netsuiteOrderId: 959552, tranid: "POB03745" }
  );
  assert.throws(
    () => normalizeDelayedStatusRefreshIdentity({ orderType: "transfer_order", netsuiteOrderId: 1 }),
    /order type/i
  );
  assert.throws(
    () => normalizeDelayedStatusRefreshIdentity({ orderType: "purchase_order", netsuiteOrderId: 0 }),
    /positive integer/i
  );
});

test("DSR-P2: pending approval recognizes both NetSuite code and normalized status text", () => {
  assert.equal(isDelayedStatusPendingApproval({ status: "A", statusText: "Anything" }), true);
  assert.equal(isDelayedStatusPendingApproval({ status: "", status_text: "Purchase Order : Pending Supervisor Approval" }), true);
  assert.equal(isDelayedStatusPendingApproval({ status: "B", statusText: "Purchase Order : Pending Receipt" }), false);
});

test("DSR-P3: retry backoff is exact and bounded at eight total attempts", () => {
  assert.equal(DELAYED_STATUS_REFRESH_MAX_ATTEMPTS, 8);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => delayedStatusRefreshRetryDelayMs(index + 1)),
    [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, null]
  );
});

test("DSR-P4: status, missing, transient, and allocation outcomes obey the retry budget", () => {
  assert.deepEqual(
    delayedStatusRefreshDecision({
      attemptNumber: 1,
      remoteStatus: { status: "A", statusText: "Pending Supervisor Approval" }
    }),
    { outcome: "retry", reason: "pending_approval", retryDelayMs: 30_000 }
  );
  assert.deepEqual(
    delayedStatusRefreshDecision({ attemptNumber: 8, remoteStatus: null }),
    { outcome: "failed", reason: "missing_status", retryDelayMs: null }
  );
  assert.deepEqual(
    delayedStatusRefreshDecision({ attemptNumber: 1, error: new Error("network down") }),
    { outcome: "retry", reason: "transient_error", retryDelayMs: 30_000 }
  );
  assert.deepEqual(
    delayedStatusRefreshDecision({
      attemptNumber: 1,
      remoteStatus: { status: "B", statusText: "Pending Fulfillment" },
      allocationRefresh: { unsettledLineCount: 1 }
    }),
    { outcome: "retry", reason: "sales_order_allocations_unsettled", retryDelayMs: 30_000 }
  );
  assert.deepEqual(
    delayedStatusRefreshDecision({
      attemptNumber: 2,
      remoteStatus: { status: "B", statusText: "Pending Fulfillment" },
      allocationRefreshError: "still settling"
    }),
    { outcome: "succeeded", reason: "status_refreshed", retryDelayMs: null }
  );
});

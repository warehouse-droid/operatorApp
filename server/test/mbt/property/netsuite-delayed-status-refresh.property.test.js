import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  delayedStatusRefreshDecision,
  delayedStatusRefreshRetryDelayMs,
  normalizeDelayedStatusRefreshIdentity
} from "../../../src/netsuite-delayed-status-refresh-policy.js";

test("DSR-PR1: every pre-terminal attempt has one positive delay and terminal attempts never retry", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), (attemptNumber) => {
    const delay = delayedStatusRefreshRetryDelayMs(attemptNumber);
    if (attemptNumber < 8) {
      assert.equal(Number.isInteger(delay) && delay > 0, true);
    } else {
      assert.equal(delay, null);
      const decision = delayedStatusRefreshDecision({
        attemptNumber,
        remoteStatus: { status: "A", statusText: "Pending Approval" }
      });
      assert.equal(decision.outcome, "failed");
      assert.equal(decision.retryDelayMs, null);
    }
  }), { numRuns: 1_000 });
});

test("DSR-PR2: normalized identities preserve every valid positive integer without coercing fractions", () => {
  fc.assert(fc.property(
    fc.constantFrom("sales_order", "purchase_order", "transfer_order"),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.string(),
    (orderType, netsuiteOrderId, tranid) => {
      const normalized = normalizeDelayedStatusRefreshIdentity({ orderType, netsuiteOrderId, tranid });
      assert.equal(normalized.netsuiteOrderId, netsuiteOrderId);
      assert.equal(normalized.tranid, tranid.trim());
    }
  ), { numRuns: 1_000 });

  fc.assert(fc.property(
    fc.double({ min: 0.01, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
      .filter((value) => !Number.isInteger(value)),
    (netsuiteOrderId) => {
      assert.throws(
        () => normalizeDelayedStatusRefreshIdentity({ orderType: "purchase_order", netsuiteOrderId }),
        /positive integer/i
      );
    }
  ), { numRuns: 1_000 });
});

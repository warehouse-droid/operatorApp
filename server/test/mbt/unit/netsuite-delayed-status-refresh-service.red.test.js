import assert from "node:assert/strict";
import test from "node:test";

import {
  createDelayedStatusRefreshWorker,
  summarizeSalesOrderAllocationRefresh
} from "../../../src/netsuite-delayed-status-refresh-service.js";

function job(overrides = {}) {
  return {
    jobId: 71,
    orderType: "purchase_order",
    netsuiteOrderId: 959552,
    tranid: "POB03745",
    attemptNumber: 1,
    leaseToken: "76c05de8-a764-439c-959b-1bf7724189a7", // secret-scan: allow deterministic lease fixture
    ...overrides
  };
}

function harness(overrides = {}) {
  const calls = {
    applied: [],
    lines: [],
    finished: [],
    audits: [],
    events: []
  };
  const worker = createDelayedStatusRefreshWorker({
    claimJobs: async () => [],
    lockLease: async () => true,
    finishAttempt: async (input) => {
      calls.finished.push(input);
      return true;
    },
    fetchTransactionStatus: async () => ({
      tranid: "POB03745",
      status: "B",
      status_text: "Purchase Order : Pending Receipt"
    }),
    fetchSalesOrderLines: async () => [],
    applyStatus: async (input) => {
      calls.applied.push(input);
      return { netsuiteId: input.netsuiteOrderId };
    },
    applySalesOrderLines: async (input) => calls.lines.push(input),
    withTransaction: async (operation) => operation(),
    writeAudit: async (input) => calls.audits.push(input),
    emitEvents: (input) => calls.events.push(input),
    now: () => new Date("2026-08-19T12:26:20.000Z"),
    logger: { error() {} },
    ...overrides
  });
  return { worker, calls };
}

test("DSR-S1: a non-pending PO status commits local status, durable outcome, audit, and events", async () => {
  const { worker, calls } = harness();
  const result = await worker.processJob(job());

  assert.equal(result.outcome, "succeeded");
  assert.equal(calls.applied.length, 1);
  assert.equal(calls.finished.length, 1);
  assert.equal(calls.finished[0].outcome, "succeeded");
  assert.equal(calls.audits[0].action, "netsuite.webhook.delayed_status_refresh");
  assert.equal(calls.audits[0].details.jobId, 71);
  assert.equal(calls.audits[0].details.attemptNumber, 1);
  assert.equal(calls.events.length, 1);
});

test("DSR-S2: Pending Approval is durably retried and the next status can succeed", async () => {
  const statuses = [
    { status: "A", status_text: "Purchase Order : Pending Supervisor Approval" },
    { status: "B", status_text: "Purchase Order : Pending Receipt" }
  ];
  const { worker, calls } = harness({ fetchTransactionStatus: async () => statuses.shift() });

  const first = await worker.processJob(job());
  assert.deepEqual(
    { outcome: first.outcome, reason: first.reason, nextAvailableAt: first.nextAvailableAt.toISOString() },
    { outcome: "retry", reason: "pending_approval", nextAvailableAt: "2026-08-19T12:26:50.000Z" }
  );
  assert.equal(calls.finished[0].outcome, "retry");

  const second = await worker.processJob(job({ attemptNumber: 2 }));
  assert.equal(second.outcome, "succeeded");
  assert.equal(calls.finished[1].outcome, "succeeded");
});

test("DSR-S3: a stale lease cannot mutate status, finish an attempt, or emit events", async () => {
  const { worker, calls } = harness({ lockLease: async () => false });
  const result = await worker.processJob(job());

  assert.equal(result.outcome, "stale");
  assert.equal(calls.applied.length, 0);
  assert.equal(calls.finished.length, 0);
  assert.equal(calls.audits.length, 0);
  assert.equal(calls.events.length, 0);
});

test("DSR-S4: network errors retry, then fail at the exact attempt ceiling", async () => {
  const { worker, calls } = harness({
    fetchTransactionStatus: async () => { throw new Error("socket reset"); }
  });
  assert.equal((await worker.processJob(job())).outcome, "retry");
  assert.equal(calls.finished[0].outcome, "retry");

  assert.equal((await worker.processJob(job({ attemptNumber: 8 }))).outcome, "failed");
  assert.equal(calls.finished[1].outcome, "failed");
  assert.match(calls.finished[1].error, /socket reset/);
  assert.equal(calls.events.length, 0);
});

test("DSR-S5: supplemental audit failure cannot erase the authoritative attempt outcome", async () => {
  const { worker, calls } = harness({
    writeAudit: async () => { throw new Error("audit unavailable"); }
  });
  const result = await worker.processJob(job());

  assert.equal(result.outcome, "succeeded");
  assert.equal(calls.applied.length, 1);
  assert.equal(calls.finished.length, 1);
  assert.equal(calls.events.length, 1);
});

test("DSR-S6: runOnce is bounded and suppresses overlapping ticks in one process", async () => {
  let releaseClaim;
  const claimBarrier = new Promise((resolve) => { releaseClaim = resolve; });
  let claimCalls = 0;
  const { worker } = harness({
    claimJobs: async (input) => {
      claimCalls += 1;
      assert.equal(input.limit, 10);
      await claimBarrier;
      return [];
    }
  });

  const first = worker.runOnce({ workerId: "worker-a" });
  const overlapping = await worker.runOnce({ workerId: "worker-a" });
  assert.deepEqual(overlapping, { skipped: true, reason: "already_running" });
  releaseClaim();
  assert.deepEqual(await first, { skipped: false, claimed: 0, succeeded: 0, retried: 0, failed: 0, stale: 0 });
  assert.equal(claimCalls, 1);
});

test("DSR-S7: a live worker renews its fenced lease while NetSuite is still pending", async () => {
  let heartbeat;
  let heartbeatCleared = false;
  let releaseFetch;
  const fetchBarrier = new Promise((resolve) => { releaseFetch = resolve; });
  const renewals = [];
  const { worker } = harness({
    fetchTransactionStatus: async () => {
      await fetchBarrier;
      return { status: "B", status_text: "Purchase Order : Pending Receipt" };
    },
    renewLease: async (input) => {
      renewals.push(input);
      return true;
    },
    setIntervalFn: (callback, intervalMs) => {
      assert.equal(intervalMs, 40_000);
      heartbeat = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => { heartbeatCleared = true; }
  });

  const processing = worker.processJob(job());
  await heartbeat();
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].jobId, 71);
  assert.equal(renewals[0].leaseMs, 120_000);
  releaseFetch();
  assert.equal((await processing).outcome, "succeeded");
  assert.equal(heartbeatCleared, true);
});

test("DSR-S8: sales-order allocation details are summarized, persisted, and retried once", async () => {
  const lines = [
    { quantity: 10, netsuite_committed_qty: 0, netsuite_backordered_qty: 2, netsuite_received_qty: 0 },
    { quantity: 5, netsuite_committed_qty: 0, netsuite_backordered_qty: 0, netsuite_received_qty: 0 },
    { quantity: "invalid", netsuite_committed_qty: 0, netsuite_backordered_qty: 0.1234567, netsuite_received_qty: 0 }
  ];
  assert.deepEqual(summarizeSalesOrderAllocationRefresh(null), {
    lineCount: 0,
    backorderedLineCount: 0,
    backorderedQuantity: 0,
    unsettledLineCount: 0
  });
  const { worker, calls } = harness({
    fetchSalesOrderLines: async () => lines
  });
  const result = await worker.processJob(job({ orderType: "sales_order", tranid: "SO-ALLOC" }));

  assert.equal(result.outcome, "retry");
  assert.equal(result.reason, "sales_order_allocations_unsettled");
  assert.deepEqual(calls.lines, [{ netsuiteOrderId: 959552, lines }]);
  assert.deepEqual(calls.finished[0].details.allocationRefresh, {
    lineCount: 3,
    backorderedLineCount: 2,
    backorderedQuantity: 2.123457,
    unsettledLineCount: 1
  });
});

test("DSR-S9: allocation fetch errors retry once and missing statuses retain the legacy missing audit/event", async () => {
  const allocation = harness({
    fetchSalesOrderLines: async () => { throw new Error("allocation query failed"); }
  });
  const allocationResult = await allocation.worker.processJob(job({ orderType: "sales_order" }));
  assert.equal(allocationResult.outcome, "retry");
  assert.match(allocation.calls.finished[0].error, /allocation query failed/);

  const missing = harness({ fetchTransactionStatus: async () => null });
  const missingResult = await missing.worker.processJob(job());
  assert.equal(missingResult.outcome, "retry");
  assert.equal(missing.calls.audits[0].action, "netsuite.webhook.delayed_status_missing");
  assert.equal(missing.calls.events.length, 1);
});

test("DSR-S10: invalid jobs and missing dependencies fail closed", async () => {
  assert.throws(() => createDelayedStatusRefreshWorker({}), /claimJobs/);
  const { worker } = harness();
  await assert.rejects(() => worker.processJob(job({ jobId: 0 })), /job ID/i);
  await assert.rejects(() => worker.processJob(job({ attemptNumber: 0 })), /attempt number/i);
  await assert.rejects(() => worker.processJob(job({ leaseToken: "" })), /lease token/i);
  await assert.rejects(() => worker.processJob(job({ leaseMs: -1 })), /lease duration/i);
});

test("DSR-S11: heartbeat overlap, fencing, and renewal errors are contained", async () => {
  let heartbeat;
  let releaseFetch;
  let releaseRenewal;
  let renewalCall = 0;
  const logs = [];
  const fetchBarrier = new Promise((resolve) => { releaseFetch = resolve; });
  const firstRenewal = new Promise((resolve) => { releaseRenewal = resolve; });
  const { worker } = harness({
    fetchTransactionStatus: async () => {
      await fetchBarrier;
      return { status: "B", status_text: "Pending Receipt" };
    },
    renewLease: async () => {
      renewalCall += 1;
      if (renewalCall === 1) {
        await firstRenewal;
        return false;
      }
      throw new Error("renewal database unavailable");
    },
    setIntervalFn: (callback) => {
      heartbeat = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    logger: { error: (...input) => logs.push(input.join(" ")) }
  });

  const processing = worker.processJob(job());
  const inFlight = heartbeat();
  await heartbeat();
  assert.equal(renewalCall, 1);
  releaseRenewal();
  await inFlight;
  await heartbeat();
  assert.equal(renewalCall, 2);
  releaseFetch();
  assert.equal((await processing).outcome, "succeeded");
  assert.equal(logs.some((entry) => /renewal was fenced/i.test(entry)), true);
  assert.equal(logs.some((entry) => /renewal failed.*unavailable/i.test(entry)), true);
});

test("DSR-S12: finalization and event failures cannot create an unowned status result", async () => {
  const finalization = harness({ finishAttempt: async () => false });
  assert.deepEqual(await finalization.worker.processJob(job()), {
    outcome: "stale",
    reason: "failure_record_deferred"
  });

  const eventFailure = harness({ emitEvents: () => { throw new Error("event client closed"); } });
  assert.equal((await eventFailure.worker.processJob(job())).outcome, "succeeded");
  assert.equal(eventFailure.calls.finished.length, 1);
});

test("DSR-S13: runOnce reports success, retry, terminal failure, and stale fencing separately", async () => {
  const claimed = [
    job({ jobId: 81, netsuiteOrderId: 900081, attemptNumber: 1 }),
    job({ jobId: 82, netsuiteOrderId: 900082, attemptNumber: 1 }),
    job({ jobId: 83, netsuiteOrderId: 900083, attemptNumber: 8 }),
    job({ jobId: 84, netsuiteOrderId: 900084, attemptNumber: 1 })
  ];
  const { worker } = harness({
    claimJobs: async () => claimed,
    lockLease: async ({ jobId }) => jobId !== 84,
    fetchTransactionStatus: async ({ netsuiteOrderId }) => netsuiteOrderId === 900081
      ? { status: "B", status_text: "Pending Receipt" }
      : { status: "A", status_text: "Pending Supervisor Approval" }
  });
  assert.deepEqual(await worker.runOnce({ workerId: "summary-worker" }), {
    skipped: false,
    claimed: 4,
    succeeded: 1,
    retried: 1,
    failed: 1,
    stale: 1
  });
});

test("DSR-S14: every job in a claimed batch starts before the first slow NetSuite call completes", async () => {
  const claimed = [
    job({ jobId: 91, netsuiteOrderId: 900091 }),
    job({ jobId: 92, netsuiteOrderId: 900092 })
  ];
  let started = 0;
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  const { worker } = harness({
    claimJobs: async () => claimed,
    fetchTransactionStatus: async () => {
      started += 1;
      if (started === claimed.length) {
        releaseBoth();
      }
      await bothStarted;
      return { status: "B", status_text: "Pending Receipt" };
    }
  });
  assert.deepEqual(await worker.runOnce({ workerId: "batch-worker" }), {
    skipped: false,
    claimed: 2,
    succeeded: 2,
    retried: 0,
    failed: 0,
    stale: 0
  });
  assert.equal(started, 2);
});

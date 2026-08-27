import assert from "node:assert/strict";
import test from "node:test";

import {
  createScmScheduleStatusRefresh,
  selectBoundedScmScheduleStatusRefreshBatch
} from "../../../src/scm-schedule-status-refresh.js";

test("SAS-R1: a refresh batch is one order family, deduplicated, and capped at ten", () => {
  const rows = [
    { orderKind: "TO", orderRef: "TOB00960" },
    { orderKind: "PO", orderRef: "POB03297" },
    { orderKind: "TO", orderRef: "tob00960" },
    ...Array.from({ length: 15 }, (_, index) => ({
      orderKind: "TO",
      orderRef: `TO-STALE-${index}`
    }))
  ];
  const batch = selectBoundedScmScheduleStatusRefreshBatch(rows);
  assert.equal(batch.length, 10);
  assert.equal(batch.every((candidate) => candidate.orderKind === "TO"), true);
  assert.equal(new Set(batch.map((candidate) => candidate.orderRef.toLowerCase())).size, 10);
});

function refreshHarness(overrides = {}) {
  const calls = [];
  const refresh = createScmScheduleStatusRefresh({
    getSettings: async () => ({ initialDryRunApprovedAt: "2026-08-09T05:20:18.000Z" }),
    hasActiveReconciliation: async () => false,
    listCandidates: async () => [
      { orderKind: "PO", orderRef: "POB03297" },
      { orderKind: "PO", orderRef: "POB03298" },
      { orderKind: "TO", orderRef: "TOB00960" }
    ],
    operationalSyncRunning: async () => false,
    startRun: async (...input) => {
      calls.push(input);
      return { id: 901 };
    },
    ...overrides
  });
  return { refresh, calls };
}

test("SAS-R2: the scheduler starts one bounded targeted apply, never a broad sweep", async () => {
  const { refresh, calls } = refreshHarness();
  const result = await refresh.runOnce({ now: new Date("2026-08-27T12:00:00.000Z") });
  assert.deepEqual(result, {
    started: true,
    runId: 901,
    orderKind: "PO",
    orderRefs: ["POB03297", "POB03298"]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].scope, "order_family");
  assert.equal(calls[0][0].targetOrderKind, "PO");
  assert.deepEqual(calls[0][0].targetOrderRefs, ["POB03297", "POB03298"]);
  assert.equal(calls[0][0].dryRun, false);
  assert.equal(calls[0][1].background, true);
});

test("SAS-R3: approval, operational work, and an active reconciliation each fail closed", async () => {
  const unapproved = refreshHarness({ getSettings: async () => ({ initialDryRunApprovedAt: null }) });
  assert.equal((await unapproved.refresh.runOnce()).reason, "initial_dry_run_not_approved");
  assert.equal(unapproved.calls.length, 0);

  const operational = refreshHarness({ operationalSyncRunning: async () => true });
  assert.equal((await operational.refresh.runOnce()).reason, "operational_sync_running");
  assert.equal(operational.calls.length, 0);

  const active = refreshHarness({ hasActiveReconciliation: async () => true });
  assert.equal((await active.refresh.runOnce()).reason, "reconciliation_active");
  assert.equal(active.calls.length, 0);
});

test("SAS-R4: empty/hostile candidates are a no-op and dependencies fail closed", async () => {
  assert.deepEqual(selectBoundedScmScheduleStatusRefreshBatch([
    null,
    { orderKind: "SO", orderRef: "SO-NOT-IN-SCOPE" },
    { orderKind: "PO", orderRef: "" }
  ]), []);
  assert.throws(() => createScmScheduleStatusRefresh({}), /getSettings/);

  const empty = refreshHarness({ listCandidates: async () => [] });
  assert.deepEqual(await empty.refresh.runOnce(), {
    started: false,
    reason: "no_stale_scheduled_orders"
  });
  assert.equal(empty.calls.length, 0);
});

test("SAS-R5: overlapping scheduler ticks cannot start two reconciliation runs", async () => {
  let releaseCandidates;
  const candidateBarrier = new Promise((resolve) => { releaseCandidates = resolve; });
  const { refresh, calls } = refreshHarness({
    listCandidates: async () => {
      await candidateBarrier;
      return [{ orderKind: "PO", orderRef: "POB03297" }];
    }
  });
  const first = refresh.runOnce();
  assert.deepEqual(await refresh.runOnce(), { started: false, reason: "tick_in_progress" });
  releaseCandidates();
  assert.equal((await first).started, true);
  assert.equal(calls.length, 1);
});

test("SAS-R6: operational-work detection defaults safely when no detector is supplied", async () => {
  const calls = [];
  const refresh = createScmScheduleStatusRefresh({
    getSettings: async () => ({ initialDryRunApprovedAt: "2026-08-09T05:20:18.000Z" }),
    hasActiveReconciliation: async () => false,
    listCandidates: async () => [{ orderKind: "TO", orderRef: "TOB00960" }],
    startRun: async (input) => {
      calls.push(input);
      return {};
    }
  });

  assert.deepEqual(await refresh.runOnce(), {
    started: true,
    runId: null,
    orderKind: "TO",
    orderRefs: ["TOB00960"]
  });
  assert.equal(calls.length, 1);
});

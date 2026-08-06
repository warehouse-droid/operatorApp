import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDispatchPlanCommand,
  createDispatchCommandReceiptStore,
  evaluateExecutedPrefixPolicy,
  resolveHistoricalPlanOrderIdentity,
  selectExpiredDispatchCheckpointIds
} from "../../../src/dispatch-planner-performance.js";

function activityPlan() {
  return {
    id: "current-plan",
    planDate: "2026-08-06",
    orders: ["A", "B", "C", "D"].map((id) => ({ id, type: "SO", items: [] })),
    trucks: [{ id: "truck-1", plate: "OLD", driverLogin: "driver-a", loads: [{
      id: "load-1",
      stops: ["A", "B", "C", "D"].map((id) => ({ id: `drop-${id}`, type: "drop", orderId: id }))
    }] }]
  };
}

test("DP-09 protects only the executed physical prefix and permits future suffix edits", () => {
  const previous = activityPlan();
  const suffixOnly = structuredClone(previous);
  suffixOnly.trucks[0].loads[0].stops = [
    ...suffixOnly.trucks[0].loads[0].stops.slice(0, 2),
    { id: "drop-D", type: "drop", orderId: "D" },
    { id: "drop-C", type: "drop", orderId: "C" },
    { id: "drop-E", type: "drop", orderId: "E" }
  ];
  const reassigned = structuredClone(previous);
  reassigned.trucks[0].plate = "NEW";
  const reorderedPrefix = structuredClone(previous);
  [reorderedPrefix.trucks[0].loads[0].stops[0], reorderedPrefix.trucks[0].loads[0].stops[1]] =
    [reorderedPrefix.trucks[0].loads[0].stops[1], reorderedPrefix.trucks[0].loads[0].stops[0]];
  const activity = [{ status: "in_progress", loadId: "load-1", stopId: "drop-B", stopType: "drop" }];

  assert.deepEqual(evaluateExecutedPrefixPolicy({ previousPlan: previous, nextPlan: suffixOnly, activity }), { allowed: true, conflicts: [] });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: previous, nextPlan: reassigned, activity }).conflicts[0].code, "DISPATCH_ACTIVE_LOAD_LOCKED");
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: previous, nextPlan: reorderedPrefix, activity }).conflicts[0].code, "DISPATCH_ACTIVE_LOAD_LOCKED");
});

test("DP-09 travel, rest, and truck-switch records alone never freeze a future physical suffix", () => {
  const previous = activityPlan();
  const next = structuredClone(previous);
  next.trucks[0].loads[0].stops.splice(3, 0, { id: "drop-E", type: "drop", orderId: "E" });

  for (const stopType of ["travel", "rest", "truck_switch"]) {
    assert.deepEqual(
      evaluateExecutedPrefixPolicy({
        previousPlan: previous,
        nextPlan: next,
        activity: [{ status: "complete", loadId: "load-1", stopType }]
      }),
      { allowed: true, conflicts: [] },
      `${stopType} must not lock untouched later work`
    );
  }
});

test("DP-08 historical plan actions preserve the older order identity and ignore later group/split shapes", () => {
  const historical = {
    id: "plan-old",
    planDate: "2026-07-01",
    orders: [{ id: "SO-44", type: "SO", address: "original" }],
    trucks: [{ id: "truck-old", loads: [{ id: "load-old", stops: [{ id: "drop-old", type: "drop", orderId: "SO-44" }] }] }]
  };
  const later = {
    id: "plan-new",
    planDate: "2026-08-06",
    orders: [
      { id: "SO-44-S1", originalOrderId: "SO-44", type: "SO" },
      { id: "SO-44-S2", originalOrderId: "SO-44", type: "SO" },
      { id: "GROUP-44", type: "GROUP", childOrders: ["SO-44-S1", "SO-44-S2"] }
    ],
    trucks: []
  };

  assert.deepEqual(
    resolveHistoricalPlanOrderIdentity({ plan: historical, orderRef: "SO-44", laterPlans: [later] }),
    { orderRef: "SO-44", planId: "plan-old", planDate: "2026-07-01", source: "historical_plan" }
  );
});

test("DP-08 historical remove then re-add succeeds when the order belongs only to that same date", () => {
  const historical = {
    id: "plan-old",
    planDate: "2026-07-01",
    revision: 4,
    orders: [{ id: "SO-44", type: "SO", address: "original" }],
    trucks: [{ id: "truck-old", loads: [{
      id: "load-old",
      stops: [{ id: "drop-old", type: "drop", orderId: "SO-44" }]
    }] }]
  };
  const receipts = createDispatchCommandReceiptStore();
  const removed = applyDispatchPlanCommand({
    plan: historical,
    receiptStore: receipts,
    command: {
      commandId: "old-remove",
      baseRevision: 4,
      type: "remove_order",
      payload: { orderRef: "SO-44" }
    }
  });
  const restored = applyDispatchPlanCommand({
    plan: removed.plan,
    receiptStore: receipts,
    command: {
      commandId: "old-readd",
      baseRevision: 5,
      type: "assign_order",
      payload: { orderRef: "SO-44", loadId: "load-old", planDate: "2026-07-01" }
    }
  });

  assert.equal(removed.revision, 5);
  assert.equal(restored.revision, 6);
  assert.equal(restored.plan.trucks[0].loads[0].stops.filter((stop) => stop.orderId === "SO-44").length, 1);
});

test("DP-14 retention removes only expired archived checkpoints, never active state, command audit, or driver evidence", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const entries = [
    { id: "archive-expired", kind: "checkpoint", current: false, archivedAt: "2026-07-30T11:59:59.999Z" },
    { id: "archive-boundary", kind: "checkpoint", current: false, archivedAt: "2026-07-30T12:00:00.000Z" },
    { id: "archive-young", kind: "checkpoint", current: false, archivedAt: "2026-07-31T12:00:00.000Z" },
    { id: "active-plan", kind: "active_plan", current: true, archivedAt: "2020-01-01T00:00:00.000Z" },
    { id: "command-audit", kind: "command", archivedAt: "2020-01-01T00:00:00.000Z" },
    { id: "driver-evidence", kind: "driver_evidence", archivedAt: "2020-01-01T00:00:00.000Z" }
  ];

  assert.deepEqual(selectExpiredDispatchCheckpointIds({ entries, now, retentionDays: 7 }), ["archive-expired"]);
});

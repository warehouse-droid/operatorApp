import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDispatchPlanCommand,
  buildCompactDispatchSnapshot,
  createDispatchCommandReceiptStore,
  digestDispatchPlan,
  dispatchPlanBoard,
  evaluateExecutedPrefixPolicy,
  resolveHistoricalPlanOrderIdentity,
  selectExpiredDispatchCheckpointIds
} from "../../../src/dispatch-planner-performance.js";

function matrixPlan() {
  return {
    id: "matrix-plan",
    planDate: "2026-08-06",
    status: "draft",
    note: "matrix",
    revision: 3,
    summary: { lane: 1 },
    orders: ["A", "B", "C", "D"].map((id) => ({
      id,
      type: "SO",
      address: `${id} address`,
      items: []
    })),
    trucks: [
      {
        id: "truck-1",
        plate: "PLATE-1",
        driverLogin: "driver-a",
        loads: [{
          id: "load-1",
          driverLogin: "driver-a",
          truckId: "truck-1",
          stops: [
            { id: "drop-a", type: "drop", orderId: "A" },
            { id: "drop-bc", type: "delivery", orderRefs: ["B", "C"] }
          ],
          orders: [{ id: "A" }, { id: "B" }, { id: "C" }]
        }]
      },
      {
        id: "truck-2",
        truckPlate: "PLATE-2",
        loads: [{ id: "load-2", stops: [{ id: "drop-d", type: "dropoff", order_id: "D" }] }]
      }
    ]
  };
}

function run(plan, type, payload, commandId = `${type}-matrix`) {
  return applyDispatchPlanCommand({
    plan,
    command: {
      commandId,
      baseRevision: plan.revision,
      baseDigest: digestDispatchPlan(plan),
      type,
      payload
    }
  });
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test("command receipt storage clones values and supports get/set/has", () => {
  const store = createDispatchCommandReceiptStore();
  const receipt = { nested: { value: 1 } };
  assert.equal(store.has("receipt-1"), false);
  const written = store.set(" receipt-1 ", receipt);
  receipt.nested.value = 2;
  written.nested.value = 3;
  assert.equal(store.has("receipt-1"), true);
  assert.deepEqual(store.get("receipt-1"), { nested: { value: 1 } });
  assert.equal(store.get("missing"), null);
});

test("compact snapshots retain every supported identity shape and recursively related plan-owned records", () => {
  const plan = matrixPlan();
  plan.trucks[0].loads[0].orders.push({ refNumber: "LOAD-ORDER" });
  plan.trucks[0].loads[0].stops.push({ id: "aliases", type: "yard", tranid: "TRAN-1", orderRef: "REF-1" });
  plan.orders.push(
    { refNumber: "LOAD-ORDER", type: "SO" },
    { tranid: "TRAN-1", type: "SO" },
    { orderRef: "REF-1", type: "SO" },
    {
      orderId: "GROUP-X",
      type: "GROUP",
      childOrders: ["CHILD-1"],
      childOrderDetails: [{ orderRef: "CHILD-1", childOrders: ["NESTED-1"] }]
    },
    { id: "CHILD-1", type: "SO" },
    { id: "NESTED-1", type: "SO" },
    { id: "OWNED-FLAG", type: "SO", planOwned: true },
    { id: "SPLIT-FLAG", type: "SO", isSplit: true },
    { id: "GROUPED-FLAG", type: "SO", isGrouped: true },
    { id: "TRANSIT-FLAG", type: "SO", transitCo: { sourceOrderId: "A" } },
    { id: "POOL-NOISE", type: "SO" }
  );

  const compact = buildCompactDispatchSnapshot(plan);
  const refs = new Set(compact.orders.map((order) => order.id || order.orderId || order.orderRef || order.tranid || order.refNumber));
  for (const expected of [
    "LOAD-ORDER", "TRAN-1", "REF-1", "GROUP-X", "CHILD-1", "NESTED-1",
    "OWNED-FLAG", "SPLIT-FLAG", "GROUPED-FLAG", "TRANSIT-FLAG"
  ]) {
    assert.equal(refs.has(expected), true, `${expected} should survive compaction`);
  }
  assert.equal(refs.has("POOL-NOISE"), false);
  assert.equal(digestDispatchPlan({ ...plan, savedAt: "volatile", revision: 99 }), digestDispatchPlan(plan));
});

test("remove_order handles shared stops and load order mirrors without deleting siblings", () => {
  const plan = matrixPlan();
  const result = run(plan, "remove_order", { orderRef: "B" });
  const load = result.plan.trucks[0].loads[0];
  assert.deepEqual(load.stops[1].orderRefs, ["C"]);
  assert.deepEqual(load.orders.map((order) => order.id), ["A", "C"]);
  assert.throws(() => run(result.plan, "remove_order", { orderRef: "missing" }), hasCode("DISPATCH_ORDER_NOT_PLANNED"));
});

test("assign_order validates identity and load ownership and supports explicit/default insertion", () => {
  const base = matrixPlan();
  assert.throws(() => run(base, "assign_order", {}), hasCode("DISPATCH_COMMAND_INVALID"));
  assert.throws(() => run(base, "assign_order", { orderRef: "A", loadId: "load-1" }), hasCode("DISPATCH_ORDER_ALREADY_PLANNED"));
  assert.throws(() => run(base, "assign_order", { orderRef: "NEW", loadId: "missing" }), hasCode("DISPATCH_LOAD_NOT_FOUND"));
  assert.throws(
    () => run(base, "assign_order", { orderRef: "NEW", loadId: "load-1", truckId: "truck-2" }),
    hasCode("DISPATCH_LOAD_NOT_FOUND")
  );

  const withNew = structuredClone(base);
  withNew.orders.push({ id: "NEW", type: "SO", dropoffLocation: "new destination" });
  const inserted = run(withNew, "assign_order", {
    orderRef: "NEW",
    loadId: "load-1",
    truckId: "PLATE-1",
    afterStopId: "drop-a",
    stopId: "new-stop",
    stopType: "pickup"
  });
  assert.equal(inserted.plan.trucks[0].loads[0].stops[1].id, "new-stop");
  assert.equal(inserted.plan.trucks[0].loads[0].stops[1].location, "new destination");

  const explicit = run(withNew, "assign_order", {
    orderRef: "NEW",
    loadId: "load-1",
    stop: { id: "explicit", type: "return", orderRef: "NEW" }
  }, "assign-explicit");
  assert.deepEqual(explicit.patch.stop, { id: "explicit", type: "return", orderRef: "NEW" });
});

test("group and ungroup cover validation, deterministic grouping, fallback children, and placement", () => {
  const base = matrixPlan();
  assert.throws(() => run(base, "group_orders", { orderRefs: ["A"] }), hasCode("DISPATCH_GROUP_INVALID"));
  assert.throws(() => run(base, "group_orders", { orderRefs: ["X", "Y"] }), hasCode("DISPATCH_ORDER_NOT_PLANNED"));
  assert.throws(() => run(base, "group_orders", { orderRefs: ["A", "D"] }), hasCode("DISPATCH_GROUP_LOAD_MISMATCH"));

  const grouped = run(base, "group_orders", { orderRefs: ["A", "B"], groupRef: "GROUP-AB", stopId: "group-stop" });
  assert.equal(grouped.patch.group.ref, "GROUP-AB");
  assert.equal(grouped.plan.trucks[0].loads[0].stops[0].id, "group-stop");
  assert.deepEqual(grouped.plan.trucks[0].loads[0].stops[0].groupedOrderRefs, ["A", "B"]);
  assert.throws(() => run(base, "ungroup_orders", { groupRef: "missing" }), hasCode("DISPATCH_GROUP_NOT_FOUND"));

  const ungrouped = run(grouped.plan, "ungroup_orders", { groupRef: "GROUP-AB" });
  assert.deepEqual(ungrouped.patch.ungroupedOrderRefs, ["A", "B"]);
  assert.equal(ungrouped.plan.orders.some((order) => order.id === "GROUP-AB"), false);

  const fallback = matrixPlan();
  fallback.orders.push({ id: "GROUP-FALLBACK", type: "GROUP" });
  fallback.trucks[0].loads[0].stops.push({ id: "fallback-stop", type: "drop", orderId: "GROUP-FALLBACK" });
  const fallbackResult = run(fallback, "ungroup_orders", {
    groupRef: "GROUP-FALLBACK",
    orderRefs: ["A", "B"]
  }, "ungroup-fallback");
  assert.equal(fallbackResult.plan.trucks[0].loads[0].stops.filter((stop) => ["A", "B"].includes(stop.orderId)).length >= 2, true);
});

test("split and unsplit cover defaults, explicit refs, stop replacement, missing source, and optional replan", () => {
  const base = matrixPlan();
  assert.throws(() => run(base, "split_order", { sourceOrderRef: "missing" }), hasCode("DISPATCH_ORDER_NOT_FOUND"));
  const split = run(base, "split_order", {
    sourceOrderRef: "A",
    parts: [{ refNumber: "A-X", quantity: 1 }, { orderRef: "A-Y", quantity: 2 }]
  });
  assert.deepEqual(split.patch.split.parts.map((part) => part.refNumber), ["A-X", "A-Y"]);
  assert.deepEqual(split.plan.trucks[0].loads[0].stops.slice(0, 2).map((stop) => stop.orderId), ["A-X", "A-Y"]);
  assert.throws(() => run(base, "unsplit_order", { sourceOrderRef: "A" }), hasCode("DISPATCH_SPLIT_NOT_FOUND"));

  const unsplit = run(split.plan, "unsplit_order", {
    sourceOrderRef: "A",
    loadId: "load-2",
    truckId: "truck-2",
    stopId: "restored-a"
  });
  assert.deepEqual(unsplit.patch.unsplit.removedPartRefs, ["A-X", "A-Y"]);
  assert.equal(unsplit.plan.trucks[1].loads[0].stops.at(-1).id, "restored-a");

  const defaultSplit = run(base, "split_order", { orderRef: "B" }, "split-default");
  assert.deepEqual(defaultSplit.patch.split.parts.map((part) => part.refNumber), ["B-S1", "B-S2"]);
  const noTarget = run(defaultSplit.plan, "unsplit_order", { orderRef: "B" }, "unsplit-no-target");
  assert.equal(noTarget.plan.orders.some((order) => order.originalOrderId === "B"), false);
});

test("upsert_co replaces the same CO and rejects missing source/reference", () => {
  const base = matrixPlan();
  assert.throws(() => run(base, "upsert_co", { sourceOrderRef: "missing", coRef: "CO-1" }), hasCode("DISPATCH_ORDER_NOT_FOUND"));
  assert.throws(() => run(base, "upsert_co", { sourceOrderRef: "A", co: {} }), hasCode("DISPATCH_CO_INVALID"));
  const created = run(base, "upsert_co", {
    sourceOrderRef: "A",
    co: { id: "CO-1", transitCo: { yard: "3445" }, note: "first" }
  });
  assert.equal(created.patch.co.transitCo.sourceOrderId, "A");
  assert.equal(created.patch.co.transitCo.yard, "3445");
  const updated = run(created.plan, "upsert_co", {
    sourceOrderRef: "A",
    co: { refNumber: "CO-1", note: "updated" }
  }, "co-update");
  assert.equal(updated.plan.orders.filter((order) => order.id === "CO-1").length, 1);
  assert.equal(updated.patch.co.note, "updated");
});

test("replace_plan validates shape/date and returns normalized follow-up metadata", () => {
  const base = matrixPlan();
  assert.throws(() => run(base, "replace_plan", { orders: [] }), hasCode("DISPATCH_COMMAND_INVALID"));
  assert.throws(
    () => run(base, "replace_plan", { planDate: "2026-08-07", orders: [], trucks: [] }),
    (error) => error?.code === "DISPATCH_PLAN_DATE_MISMATCH"
      && error.expectedPlanDate === "2026-08-06"
      && error.payloadPlanDate === "2026-08-07"
  );
  const replaced = run(base, "replace_plan", {
    orders: [{ id: "LOCAL", type: "CUSTOM" }],
    trucks: [],
    summary: null,
    affectedOrderRefs: ["LOCAL", "LOCAL", ""],
    operatorAlertRefs: ["A", "A"],
    refreshOrderPool: true,
    safeUngroupTargets: [{ ref: "GROUP-X" }]
  }, "replace-defaults");
  assert.equal(replaced.patch.actionName, "dispatch_plan_autosaved");
  assert.deepEqual(replaced.patch.affectedOrderRefs, ["LOCAL"]);
  assert.deepEqual(replaced.patch.operatorAlertRefs, ["A"]);
  assert.equal(replaced.patch.refreshOrderPool, true);
  assert.deepEqual(replaced.patch.safeUngroupTargets, [{ ref: "GROUP-X" }]);
  assert.deepEqual(replaced.plan.summary, {});
});

test("command envelope rejects missing IDs, stale revisions, and unknown command types", () => {
  const base = matrixPlan();
  assert.throws(
    () => applyDispatchPlanCommand({ plan: base, command: { baseRevision: 3, type: "remove_order", payload: { orderRef: "A" } } }),
    hasCode("DISPATCH_COMMAND_INVALID")
  );
  assert.throws(
    () => applyDispatchPlanCommand({ plan: base, command: { commandId: "stale", baseRevision: 2, type: "remove_order", payload: { orderRef: "A" } } }),
    (error) => error?.code === "STALE_DISPATCH_PLAN" && error.expectedRevision === 2 && error.currentRevision === 3
  );
  assert.throws(() => run(base, "not_supported", {}), hasCode("DISPATCH_COMMAND_UNSUPPORTED"));
});

test("executed-prefix policy covers aliases, inactive evidence, missing stops/loads, and assignment removal", () => {
  const previous = matrixPlan();
  previous.trucks[0].loads[0].stops.unshift({ type: "travel", orderId: "TRAVEL" });
  previous.trucks[0].loads[0].stops[1].id = "";
  const unchanged = structuredClone(previous);
  assert.deepEqual(evaluateExecutedPrefixPolicy({
    previousPlan: previous,
    nextPlan: unchanged,
    activity: [
      { status: "pending", load_id: "load-1", stop_type: "drop", orderRef: "A" },
      { status: "complete", load_id: "missing", stop_type: "drop", orderRef: "A" },
      { status: "complete", load_id: "load-1", stop_type: "rest", orderRef: "A" },
      { status: "complete", load_id: "load-1", stop_type: "drop", orderRef: "A" }
    ]
  }), { allowed: true, conflicts: [] });

  const missingNext = structuredClone(previous);
  missingNext.trucks[0].loads = [];
  const locked = evaluateExecutedPrefixPolicy({
    previousPlan: previous,
    nextPlan: missingNext,
    activity: [{ status: "complete", loadId: "load-1", stopType: "drop", stopId: "not-found" }]
  });
  assert.equal(locked.allowed, false);
  assert.equal(locked.conflicts[0].throughStopIndex, 1);

  const driverChanged = structuredClone(previous);
  driverChanged.trucks[0].loads[0].driverLogin = "driver-b";
  assert.equal(evaluateExecutedPrefixPolicy({
    previousPlan: previous,
    nextPlan: driverChanged,
    activity: [{ status: "in_progress", loadId: "load-1", orderRef: "A" }]
  }).allowed, false);
});

test("historical identity, retention, and board summaries cover fallback forms", () => {
  const plan = matrixPlan();
  plan.planId = "fallback-plan-id";
  plan.orders.push({ id: "GROUP-X", childOrders: ["OLD-A"], type: "GROUP" });
  assert.deepEqual(resolveHistoricalPlanOrderIdentity({ plan, orderRef: "OLD-A" }), {
    orderRef: "GROUP-X",
    planId: "matrix-plan",
    planDate: "2026-08-06",
    source: "historical_plan"
  });
  assert.deepEqual(resolveHistoricalPlanOrderIdentity({ plan: { planId: "fallback-plan-id" }, orderRef: "UNKNOWN" }), {
    orderRef: "UNKNOWN",
    planId: "fallback-plan-id",
    planDate: "",
    source: "historical_plan"
  });

  assert.deepEqual(selectExpiredDispatchCheckpointIds({
    now: new Date("2026-08-06T00:00:00Z"),
    entries: [
      { id: "old", kind: "checkpoint", archived_at: "2026-07-01T00:00:00Z" },
      { id: "", kind: "checkpoint", archivedAt: "2026-07-01T00:00:00Z" },
      { id: "invalid", kind: "checkpoint", archivedAt: "bad-date" }
    ]
  }), ["old"]);
  assert.deepEqual(dispatchPlanBoard(plan), {
    orderRefs: ["A", "B", "C", "D"],
    truckCount: 2,
    loadCount: 2,
    stopCount: 3
  });
});

test("defensive defaults and legacy aliases remain deterministic for sparse persisted plans", () => {
  const store = createDispatchCommandReceiptStore();
  assert.equal(store.set("undefined", undefined), undefined);
  assert.equal(store.get("undefined"), null);

  assert.deepEqual(buildCompactDispatchSnapshot({ orders: null, trucks: null }), { orders: [], trucks: [] });
  assert.deepEqual(buildCompactDispatchSnapshot({
    orders: [{}, { id: "NOISE", childOrders: "invalid", orderRefs: "invalid", childOrderDetails: "invalid" }],
    trucks: [{}]
  }).orders, []);
  assert.equal(digestDispatchPlan({
    planId: "legacy-plan-id",
    planDate: "2026-08-06T10:00:00Z",
    orders: null,
    trucks: null,
    summary: null
  }).length, 64);

  const sparse = {
    planDate: "2026-08-06",
    revision: 0,
    orders: [],
    trucks: [{ plate: "LEGACY", loads: [{ id: "legacy-load" }] }]
  };
  const assigned = applyDispatchPlanCommand({
    plan: sparse,
    command: {
      commandId: "legacy-command-type",
      baseRevision: 0,
      commandType: "assign_order",
      payload: { orderRef: "ORPHAN", loadId: "legacy-load", location: "manual address" }
    }
  });
  assert.equal(assigned.patch.stop.type, "delivery");
  assert.equal(assigned.patch.stop.location, "manual address");
  assert.match(assigned.patch.stop.id, /^dispatch-ORPHAN-/u);
  assert.throws(
    () => run({ ...matrixPlan(), trucks: null }, "assign_order", { orderRef: "X", loadId: "load" }),
    hasCode("DISPATCH_LOAD_NOT_FOUND")
  );

  const synthetic = {
    planDate: "2026-08-06",
    revision: 0,
    orders: null,
    trucks: [{ loads: [{ id: "synthetic-load", stops: [
      { type: "drop", orderRef: "X" },
      { type: "drop", tranid: "Y" }
    ] }] }]
  };
  const grouped = run(synthetic, "group_orders", { orderRefs: ["X", "Y"] }, "group-synthetic");
  assert.match(grouped.patch.group.ref, /^GROUP-/u);
  assert.deepEqual(grouped.patch.group.orderRefs, ["X", "Y"]);
  assert.deepEqual(grouped.patch.group.ref, grouped.plan.orders[0].id);
  assert.throws(() => run(synthetic, "group_orders", {}), hasCode("DISPATCH_GROUP_INVALID"));

  const typeless = {
    planDate: "2026-08-06",
    revision: 0,
    orders: [{ id: "TYPELESS" }],
    trucks: null
  };
  const split = run(typeless, "split_order", { sourceOrderRef: "TYPELESS", parts: [{}] }, "split-typeless");
  assert.equal(split.patch.split.parts[0].refNumber, "TYPELESS-S1");
  assert.equal(split.plan.orders.at(-1).type, "SO");

  assert.throws(
    () => applyDispatchPlanCommand({
      plan: matrixPlan(),
      command: { commandId: "no-payload", baseRevision: 3, commandType: "remove_order" }
    }),
    hasCode("DISPATCH_ORDER_NOT_PLANNED")
  );

  const aliasPrevious = {
    trucks: [{ driver: "legacy-driver", truckPlate: "LEGACY-PLATE", loads: [{
      loadId: "legacy-load",
      driver: "legacy-driver",
      stops: [
        { stopId: "legacy-stop", stopType: "pickup", orderRef: "LEGACY-ORDER" },
        { type: "rest" }
      ]
    }] }]
  };
  const aliasNext = structuredClone(aliasPrevious);
  assert.deepEqual(evaluateExecutedPrefixPolicy({
    previousPlan: aliasPrevious,
    nextPlan: aliasNext,
    activity: [
      { status: "complete", load_id: "legacy-load", stop_id: "legacy-stop", stop_type: "pickup" },
      { status: "complete", load_id: "legacy-load", stop_id: "legacy-stop", stop_type: "pickup" }
    ]
  }), { allowed: true, conflicts: [] });
  assert.deepEqual(evaluateExecutedPrefixPolicy({
    previousPlan: { trucks: [{ loads: [{ id: "empty-load", stops: null }] }] },
    nextPlan: { trucks: [{ loads: [{ id: "empty-load", stops: null }] }] },
    activity: [{ status: "complete", loadId: "empty-load" }]
  }), { allowed: true, conflicts: [] });
  assert.deepEqual(evaluateExecutedPrefixPolicy({ previousPlan: { trucks: null }, nextPlan: {}, activity: null }), {
    allowed: true,
    conflicts: []
  });

  assert.deepEqual(selectExpiredDispatchCheckpointIds({ entries: null, retentionDays: 0 }), []);
  assert.deepEqual(dispatchPlanBoard({ trucks: null }), {
    orderRefs: [],
    truckCount: 0,
    loadCount: 0,
    stopCount: 0
  });
  assert.deepEqual(dispatchPlanBoard({ trucks: [{ loads: null }, {}] }), {
    orderRefs: [],
    truckCount: 2,
    loadCount: 0,
    stopCount: 0
  });
});

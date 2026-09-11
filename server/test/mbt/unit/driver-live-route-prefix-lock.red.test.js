import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { selectDriverRouteCursor } from "../../../src/driver-route-cursor.js";
import {
  activeDropRecord,
  cursorJobs,
  liveRoutePlan
} from "../../support/driver-live-route-prefix-lock-fixture.mjs";

function routePolicy(nextPlan, activity = [activeDropRecord()]) {
  return evaluateExecutedPrefixPolicy({ previousPlan: liveRoutePlan(), nextPlan, activity });
}

test("BL42349: an empty load before Mike's active stop cannot be deleted or changed", () => {
  const deleted = liveRoutePlan();
  deleted.trucks[0].loads.shift();
  const deletePolicy = routePolicy(deleted);
  assert.equal(deletePolicy.allowed, false);
  assert.equal(deletePolicy.conflicts[0]?.code, "DISPATCH_ROUTE_PREFIX_LOCKED");
  assert.deepEqual(deletePolicy.conflicts[0]?.lockedLoadIds, [
    "load-1-empty", "load-1-sn1399919", "load-2-active"
  ]);

  const renamed = liveRoutePlan();
  renamed.trucks[0].loads[0].name = "Renamed after Driver start";
  assert.equal(routePolicy(renamed).allowed, false);

  const retimed = liveRoutePlan();
  retimed.trucks[0].loads[0].plannedStartMinute += 5;
  assert.equal(routePolicy(retimed).allowed, false);
});

test("BL42349: SN1399919 and all populated predecessor evidence are immutable", () => {
  const removed = liveRoutePlan();
  removed.trucks[0].loads.splice(1, 1);
  assert.equal(routePolicy(removed).allowed, false);

  const instructionChanged = liveRoutePlan();
  instructionChanged.trucks[0].loads[1].stops[1].instructions = "Rewritten after execution";
  assert.equal(routePolicy(instructionChanged).allowed, false);

  const allocationChanged = liveRoutePlan();
  allocationChanged.orders[0].items[0].pallets = 50;
  allocationChanged.trucks[0].loads[1].orders[0].items[0].pallets = 50;
  assert.equal(routePolicy(allocationChanged).allowed, false);
});

test("the current prefix is fixed while the unexecuted suffix remains editable", () => {
  const movedCurrent = liveRoutePlan();
  movedCurrent.trucks[0].loads[2].stops.splice(0, 1);
  assert.equal(routePolicy(movedCurrent).allowed, false);

  const renamedCurrent = liveRoutePlan();
  renamedCurrent.trucks[0].loads[2].name = "Changed current load";
  assert.equal(routePolicy(renamedCurrent).allowed, false);

  const suffix = liveRoutePlan();
  suffix.trucks[0].loads[2].stops[2].location = "Replanned future customer";
  suffix.trucks[0].loads[3].plannedStartMinute += 15;
  assert.deepEqual(routePolicy(suffix), { allowed: true, conflicts: [] });

  const beforeActivity = liveRoutePlan();
  beforeActivity.trucks[0].loads.shift();
  assert.deepEqual(routePolicy(beforeActivity, []), { allowed: true, conflicts: [] });
});

test("unchanged legacy load and stop aliases do not create a false route conflict", () => {
  const previousPlan = {
    trucks: [{ driver: "legacy-driver", truckPlate: "LEGACY-PLATE", loads: [{
      loadId: "legacy-load",
      driver: "legacy-driver",
      stops: [{ stopId: "legacy-stop", stopType: "pickup", orderRef: "LEGACY-ORDER" }]
    }] }]
  };
  assert.deepEqual(evaluateExecutedPrefixPolicy({
    previousPlan,
    nextPlan: structuredClone(previousPlan),
    activity: [{
      status: "complete",
      load_id: "legacy-load",
      stop_id: "legacy-stop",
      stop_type: "pickup"
    }]
  }), { allowed: true, conflicts: [] });
});

test("active travel and truck-switch jobs lock their cross-load predecessor context", () => {
  for (const activity of [
    activeDropRecord({
      stop_id: "travel-12441-UNILOCK Gormley",
      stop_type: "travel",
      job_details: { toStopId: "drop-active", fromLocation: "12441", toLocation: "UNILOCK Gormley" }
    }),
    activeDropRecord({
      stop_id: "truck-switch-load-2-active",
      stop_type: "truck_switch",
      job_details: { fromTruckPlate: "OLD", nextTruckPlate: "BL42349", switchYard: "12441" }
    })
  ]) {
    const changed = liveRoutePlan();
    changed.trucks[0].loads.shift();
    const result = routePolicy(changed, [activity]);
    assert.equal(result.allowed, false);
    assert.equal(result.conflicts[0]?.code, "DISPATCH_ROUTE_PREFIX_LOCKED");
  }
});

test("an active later visit is sticky and completed progress never selects an older gap", () => {
  const jobs = cursorJobs();
  const statuses = [
    { job_id: "load-2-current", status: "in_progress", started_at: "2026-09-08T15:10:00.000Z" }
  ];
  const active = selectDriverRouteCursor({ jobs, statuses, activeRecords: statuses });
  assert.equal(active.job?.jobId, "load-2-current");
  assert.deepEqual(active.passedPendingJobIds, ["load-1-old"]);

  const completed = selectDriverRouteCursor({
    jobs,
    statuses: [{ job_id: "load-2-current", status: "complete", completed_at: "2026-09-08T15:20:00.000Z" }],
    activeRecords: []
  });
  assert.equal(completed.job?.jobId, "load-2-future");
  assert.deepEqual(completed.passedPendingJobIds, ["load-1-old"]);

  assert.equal(selectDriverRouteCursor({ jobs, statuses: [], activeRecords: [] }).job?.jobId, "load-1-old");
});

test("one consolidated visit is one active group; unrelated legacy activity raises attention", () => {
  const jobs = cursorJobs();
  jobs[1].physicalVisitJobIds = ["load-2-current", "load-2-peer"];
  jobs.splice(2, 0, {
    jobId: "load-2-peer",
    loadId: "load-2-active",
    stopId: "drop-peer",
    stopType: "dropoff",
    physicalVisitJobIds: ["load-2-current", "load-2-peer"]
  });
  const groupedRows = [
    { job_id: "load-2-current", status: "in_progress", started_at: "2026-09-08T15:10:00.000Z" },
    { job_id: "load-2-peer", status: "in_progress", started_at: "2026-09-08T15:10:00.000Z" }
  ];
  const grouped = selectDriverRouteCursor({ jobs, statuses: groupedRows, activeRecords: groupedRows });
  assert.equal(grouped.job?.jobId, "load-2-current");
  assert.equal(grouped.attention, null);

  const unrelatedRows = [
    ...groupedRows,
    { job_id: "load-3-future", status: "in_progress", started_at: "2026-09-08T15:11:00.000Z" }
  ];
  const legacy = selectDriverRouteCursor({ jobs, statuses: unrelatedRows, activeRecords: unrelatedRows });
  assert.equal(legacy.job?.jobId, "load-2-current");
  assert.equal(legacy.attention?.code, "DRIVER_MULTIPLE_ACTIVE_ROUTE_GROUPS");
});

test("an active durable job missing from the confirmed route fails closed", () => {
  assert.throws(
    () => selectDriverRouteCursor({
      jobs: cursorJobs(),
      statuses: [],
      activeRecords: [{ job_id: "orphaned-active-job", status: "in_progress" }]
    }),
    (error) => error?.status === 409
      && error?.code === "DRIVER_ACTIVE_ROUTE_CONFLICT"
      && error?.activeJobIds?.includes("orphaned-active-job")
  );
});

test("cursor boundary shapes are deterministic for maps, aliases, duplicates, and exhausted routes", () => {
  assert.deepEqual(selectDriverRouteCursor(), {
    job: null,
    index: -1,
    latestCompletedIndex: -1,
    passedPendingJobIds: [],
    attention: null
  });
  assert.deepEqual(selectDriverRouteCursor({ jobs: null, statuses: null, activeRecords: null }), {
    job: null,
    index: -1,
    latestCompletedIndex: -1,
    passedPendingJobIds: [],
    attention: null
  });

  const jobs = [
    { jobId: "", stopType: "travel" },
    { jobId: "first", loadId: "one" },
    { jobId: "first", loadId: "duplicate" },
    { jobId: "second", loadId: "two" },
    { jobId: "third", loadId: "three" }
  ];
  const completed = new Map([
    ["first", { jobId: "first", status: "completed" }],
    ["second", { job_id: "second", status: "done" }],
    ["third", { job_id: "third", status: "complete" }]
  ]);
  const exhausted = selectDriverRouteCursor({ jobs, statuses: completed, activeRecords: [] });
  assert.equal(exhausted.job, null);
  assert.equal(exhausted.latestCompletedIndex, 4);
  assert.deepEqual(exhausted.passedPendingJobIds, []);

  const aliasedActive = selectDriverRouteCursor({
    jobs: [{ jobId: "active", loadId: "one", physicalVisitJobIds: [] }],
    statuses: new Map(),
    activeRecords: [{ jobId: "active", status: "in_progress", startedAt: "not-a-date" }]
  });
  assert.equal(aliasedActive.job?.jobId, "active");
  assert.equal(aliasedActive.latestCompletedIndex, -1);
});

import assert from "node:assert/strict";

import { evaluateExecutedPrefixPolicy } from "../src/dispatch-planner-performance.js";
import { selectDriverRouteCursor } from "../src/driver-route-cursor.js";
import {
  activeDropRecord,
  liveRoutePlan
} from "../test/support/driver-live-route-prefix-lock-fixture.mjs";

const before = liveRoutePlan();
const incidentMutation = liveRoutePlan();
incidentMutation.trucks[0].loads = incidentMutation.trucks[0].loads.filter((load) =>
  !["load-1-empty", "load-1-sn1399919"].includes(load.id)
);
const policy = evaluateExecutedPrefixPolicy({
  previousPlan: before,
  nextPlan: incidentMutation,
  activity: [activeDropRecord()]
});
assert.equal(policy.allowed, false);
assert.equal(policy.conflicts[0]?.code, "DISPATCH_ROUTE_PREFIX_LOCKED");
assert.ok(policy.conflicts[0]?.lockedLoadIds.includes("load-1-sn1399919"));

const jobs = [
  { jobId: "travel-12441-unilock", loadId: "load-2-active", stopType: "travel" },
  { jobId: "3022191978", loadId: "load-2-active", stopId: "drop-active", stopType: "dropoff" },
  { jobId: "future-stop", loadId: "load-2-active", stopId: "drop-future", stopType: "dropoff" }
];
const activeRows = [{
  job_id: "3022191978",
  status: "in_progress",
  started_at: "2026-09-08T15:10:00.000Z"
}];
const active = selectDriverRouteCursor({ jobs, statuses: activeRows, activeRecords: activeRows });
assert.equal(active.job?.jobId, "3022191978");
assert.deepEqual(active.passedPendingJobIds, ["travel-12441-unilock"]);
const afterCompletion = selectDriverRouteCursor({
  jobs,
  statuses: [{ job_id: "3022191978", status: "complete", completed_at: "2026-09-08T15:20:00.000Z" }],
  activeRecords: []
});
assert.equal(afterCompletion.job?.jobId, "future-stop");

console.log(JSON.stringify({
  incident: "Mike / BL42349 / 2026-09-08",
  rejectedMutation: {
    removedLoadIds: ["load-1-empty", "load-1-sn1399919"],
    removedOrderRef: "SN1399919",
    newlyExposedTravel: "12441 -> UNILOCK Gormley"
  },
  policyCode: policy.conflicts[0].code,
  lockedLoadIds: policy.conflicts[0].lockedLoadIds,
  activeJobBeforeCompletion: active.job.jobId,
  nextJobAfterCompletion: afterCompletion.job.jobId,
  passedPendingEvidenceFabricated: false
}, null, 2));

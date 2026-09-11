import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { selectDriverRouteCursor } from "../../../src/driver-route-cursor.js";
import { activeDropRecord, liveRoutePlan } from "../../support/driver-live-route-prefix-lock-fixture.mjs";

test("duplicate and alias-shaped activity cannot weaken the route prefix boundary", () => {
  const previousPlan = liveRoutePlan();
  const nextPlan = liveRoutePlan();
  nextPlan.trucks[0].loads.splice(0, 2);
  const snake = activeDropRecord({ loadId: undefined, stopId: undefined, stopType: undefined });
  const result = evaluateExecutedPrefixPolicy({
    previousPlan,
    nextPlan,
    activity: [snake, structuredClone(snake), { status: "pending", load_id: "load-3-future" }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.conflicts.filter((item) => item.code === "DISPATCH_ROUTE_PREFIX_LOCKED").length, 1);
});

test("hostile active identities fail closed without prototype or scalar coercion", () => {
  for (const activeJobId of ["", "missing", "__proto__", "[object Object]"]) {
    assert.throws(
      () => selectDriverRouteCursor({
        jobs: [{ jobId: "safe", stopType: "dropoff" }],
        statuses: [],
        activeRecords: [{ job_id: activeJobId, status: "in_progress" }]
      }),
      (error) => error?.code === "DRIVER_ACTIVE_ROUTE_CONFLICT"
    );
  }
});

test("a changed or cross-load active physical-visit declaration fails closed", () => {
  assert.throws(
    () => selectDriverRouteCursor({
      jobs: [{
        jobId: "active",
        loadId: "load-a",
        physicalVisitJobIds: ["active", "missing", "missing", ""]
      }],
      statuses: [{ job_id: "active", status: "in_progress" }]
    }),
    (error) => error?.reason === "active_physical_visit_changed"
      && error?.missingJobIds?.includes("missing")
  );

  assert.throws(
    () => selectDriverRouteCursor({
      jobs: [
        { jobId: "active", loadId: "load-a", physicalVisitJobIds: ["active", "peer"] },
        { jobId: "peer", loadId: "load-b", physicalVisitJobIds: ["active", "peer"] }
      ],
      statuses: [{ job_id: "active", status: "in_progress" }]
    }),
    (error) => error?.reason === "active_physical_visit_crosses_loads"
  );
});

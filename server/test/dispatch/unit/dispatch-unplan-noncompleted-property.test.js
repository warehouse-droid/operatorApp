import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";

function seededRandom(seed = 0x8a08) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fixture(stopCount) {
  const stops = Array.from({ length: stopCount }, (_, index) => ({
    id: `DROP-${index + 1}`,
    type: "drop",
    orderId: `SO-RANDOM-${index + 1}`
  }));
  return {
    id: "PLAN-RANDOM-UNPLAN",
    planDate: "2026-08-08",
    trucks: [{
      id: "TRUCK-1",
      plate: "TEST-TRUCK",
      driverLogin: "test-driver",
      loads: [{ id: "LOAD-1", driverLogin: "test-driver", stops }]
    }]
  };
}

function withoutStop(plan, stopIndex) {
  const next = structuredClone(plan);
  next.trucks[0].loads[0].stops.splice(stopIndex, 1);
  return next;
}

test("random non-completed future orders can be unplanned normally", () => {
  const random = seededRandom();
  for (let sample = 0; sample < 1_000; sample += 1) {
    const stopCount = 3 + Math.floor(random() * 10);
    const previousPlan = fixture(stopCount);
    const removalIndex = Math.floor(random() * stopCount);
    const hasEarlierActivity = removalIndex > 0 && random() >= 0.5;
    const activityIndex = hasEarlierActivity
      ? Math.floor(random() * removalIndex)
      : -1;
    const activity = activityIndex >= 0 ? [{
      loadId: "LOAD-1",
      stopId: `DROP-${activityIndex + 1}`,
      orderRef: `SO-RANDOM-${activityIndex + 1}`,
      stopType: "dropoff",
      status: random() >= 0.5 ? "in_progress" : "complete"
    }] : [];

    const nextPlan = withoutStop(previousPlan, removalIndex);
    const result = evaluateExecutedPrefixPolicy({ previousPlan, nextPlan, activity });
    assert.equal(
      result.allowed,
      true,
      `Sample ${sample}: unstarted future stop ${removalIndex} was blocked after activity ${activityIndex}`
    );
    assert.deepEqual(result.conflicts, []);
    assert.equal(
      nextPlan.trucks[0].loads[0].stops.some((stop) => stop.id === `DROP-${removalIndex + 1}`),
      false
    );
  }
});

test("random started or completed orders cannot be silently unplanned", () => {
  const random = seededRandom(0x8a09);
  for (let sample = 0; sample < 250; sample += 1) {
    const stopCount = 2 + Math.floor(random() * 10);
    const removalIndex = Math.floor(random() * stopCount);
    const previousPlan = fixture(stopCount);
    const nextPlan = withoutStop(previousPlan, removalIndex);
    const result = evaluateExecutedPrefixPolicy({
      previousPlan,
      nextPlan,
      activity: [{
        loadId: "LOAD-1",
        stopId: `DROP-${removalIndex + 1}`,
        orderRef: `SO-RANDOM-${removalIndex + 1}`,
        stopType: "dropoff",
        status: random() >= 0.5 ? "in_progress" : "complete"
      }]
    });
    assert.equal(result.allowed, false, `Sample ${sample}: active stop removal was accepted`);
    assert.equal(result.conflicts[0]?.code, "DISPATCH_ACTIVE_LOAD_LOCKED");
  }
});
